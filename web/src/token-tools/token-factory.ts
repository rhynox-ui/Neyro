import type { NearRpcClient } from "../near/rpc";
import type { SignAndSendRequest } from "../wallet/connector";
import { TOKEN_TOOL_FEE_RECIPIENT } from "./fee-recipient";
import { getTokenToolFee } from "./fees";

/**
 * Fresh-token creation through a NEAR fungible-token factory.
 *
 * Interface source (verified, not guessed):
 * - Factory contract: https://github.com/near-examples/token-factory
 *   `contracts/factory/src/lib.rs` (Token Farm, deployed as `tkn.near`).
 * - Official NEAR docs "Using FTs → Creating a New Token" call
 *   `token.primitives.near` with the same `create_token({ args })` shape.
 *
 * Contract behaviour this module relies on:
 * - `create_token({ args: { owner_id, total_supply, metadata } })`, payable;
 *   deploys the canonical NEP-141 contract at `<lowercase symbol>.<factory>`
 *   and credits the whole `total_supply` to `owner_id`.
 * - `get_required_deposit({ args, account_id })` view returns the exact
 *   yoctoNEAR deposit (storage for code + args), so no deposit is hardcoded.
 * - `get_token({ token_id })` view returns null when the symbol is free.
 * - The lowercase symbol must match [a-z0-9]+ ("Invalid Symbol" otherwise).
 *
 * The deployed token is fixed-supply: no mint, freeze or burn authority and no
 * transfer tax. Neyro must not present those options for factory tokens.
 *
 * Before enabling signing, the browser re-checks the interface live by calling
 * the two views above on the chosen factory; if either fails, creation stays
 * disabled.
 */

export type TokenFactory = {
  accountId: string;
  label: string;
  source: string;
};

export const TOKEN_FACTORIES: readonly TokenFactory[] = [
  {
    accountId: "tkn.near",
    label: "Token Farm · tkn.near",
    source: "https://github.com/near-examples/token-factory"
  },
  {
    accountId: "token.primitives.near",
    label: "NEAR primitives · token.primitives.near",
    source: "https://docs.near.org/primitives/ft"
  }
];

export const CREATE_TOKEN_GAS = 300_000_000_000_000n;
export const MAX_ICON_DATA_URL_BYTES = 16 * 1024;
const MAX_U128 = (1n << 128n) - 1n;
// Protocol storage price: 10^19 yoctoNEAR per byte (1 NEAR per 100 kB).
const STORAGE_PRICE_PER_BYTE = 10_000_000_000_000_000_000n;

const ACCOUNT_ID =
  /^(?=.{2,64}$)(?:[a-z\d]+(?:[-_][a-z\d]+)*\.)*[a-z\d]+(?:[-_][a-z\d]+)*$/;

export type FtMetadataInput = {
  spec: "ft-1.0.0";
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
};

export type TokenArgs = {
  owner_id: string;
  total_supply: string;
  metadata: FtMetadataInput;
};

export type TokenDraft = {
  ownerId: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyBase: bigint;
  icon?: string;
};

export function tokenIdForSymbol(symbol: string): string {
  return symbol.trim().toLowerCase();
}

export function tokenAccountId(symbol: string, factoryId: string): string {
  return `${tokenIdForSymbol(symbol)}.${factoryId}`;
}

/** Returns a list of problems; an empty list means the draft is valid. */
export function validateTokenDraft(draft: TokenDraft, factoryId: string): string[] {
  const problems: string[] = [];
  const tokenId = tokenIdForSymbol(draft.symbol);

  if (!draft.name.trim()) problems.push("Name is required.");
  if (!tokenId) {
    problems.push("Symbol is required.");
  } else if (!/^[a-z0-9]+$/.test(tokenId)) {
    problems.push("Symbol may contain only letters and digits.");
  } else if (!ACCOUNT_ID.test(tokenAccountId(draft.symbol, factoryId))) {
    problems.push("Symbol is too long for a valid token account id.");
  }
  if (!Number.isInteger(draft.decimals) || draft.decimals < 0 || draft.decimals > 24) {
    problems.push("Decimals must be between 0 and 24.");
  }
  if (draft.totalSupplyBase <= 0n) problems.push("Total supply must be greater than zero.");
  if (draft.totalSupplyBase > MAX_U128) problems.push("Total supply exceeds the u128 limit.");
  if (!ACCOUNT_ID.test(draft.ownerId)) problems.push("Owner must be a valid NEAR account.");
  if (draft.icon !== undefined) {
    if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(draft.icon)) {
      problems.push("Logo must be an image data URL.");
    } else if (draft.icon.length > MAX_ICON_DATA_URL_BYTES) {
      problems.push("Logo is too large; it is stored on-chain and paid for in the deposit.");
    }
  }
  return problems;
}

export function buildTokenArgs(draft: TokenDraft): TokenArgs {
  return {
    owner_id: draft.ownerId,
    total_supply: draft.totalSupplyBase.toString(),
    metadata: {
      spec: "ft-1.0.0",
      name: draft.name.trim(),
      symbol: draft.symbol.trim(),
      ...(draft.icon ? { icon: draft.icon } : {}),
      decimals: draft.decimals
    }
  };
}

/** Parses a human decimal amount into exact base units. */
export function parseSupply(value: string, decimals: number): bigint {
  const clean = value.trim().replace(/_/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(clean)) throw new Error("Supply must be a positive number");
  const [whole, fraction = ""] = clean.split(".");
  if (fraction.length > decimals) throw new Error(`Supply has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export type FactoryQuote = {
  factoryId: string;
  tokenAccountId: string;
  symbolAvailable: boolean;
  storageDeposit: bigint;
  serviceFee: bigint;
  gasCeiling: bigint;
  totalRequired: bigint;
  availableBalance: bigint;
  sufficientBalance: boolean;
};

/**
 * Live preflight. Calls the factory's own views, so a factory that does not
 * expose this interface fails here and creation stays disabled.
 */
export async function quoteTokenCreation(
  rpc: NearRpcClient,
  factoryId: string,
  signerId: string,
  args: TokenArgs
): Promise<FactoryQuote> {
  const tokenId = tokenIdForSymbol(args.metadata.symbol);
  const [depositRaw, existing, account, gasPrice] = await Promise.all([
    rpc.viewFunction<unknown>(factoryId, "get_required_deposit", { args, account_id: signerId }),
    rpc.viewFunction<unknown>(factoryId, "get_token", { token_id: tokenId }),
    rpc.viewAccount(signerId),
    rpc.gasPrice()
  ]);

  if (typeof depositRaw !== "string" || !/^\d+$/.test(depositRaw)) {
    throw new Error(`${factoryId} returned an invalid required deposit`);
  }

  const storageDeposit = BigInt(depositRaw);
  const serviceFee = getTokenToolFee("mint");
  const gasCeiling = CREATE_TOKEN_GAS * gasPrice;
  const totalRequired = storageDeposit + serviceFee + gasCeiling;
  const locked = BigInt(account.storage_usage) * STORAGE_PRICE_PER_BYTE;
  const amount = BigInt(account.amount);
  const availableBalance = amount > locked ? amount - locked : 0n;

  return {
    factoryId,
    tokenAccountId: `${tokenId}.${factoryId}`,
    symbolAvailable: existing === null,
    storageDeposit,
    serviceFee,
    gasCeiling,
    totalRequired,
    availableBalance,
    sufficientBalance: availableBalance >= totalRequired
  };
}

/**
 * Two transactions, approved together: the factory call first, then the
 * Neyro Mint fee. A wallet that stops at the first failure therefore never
 * charges the fee for a token that was not created.
 */
export function buildTokenCreationTransactions(
  signerId: string,
  factoryId: string,
  args: TokenArgs,
  storageDeposit: bigint
): [SignAndSendRequest, SignAndSendRequest] {
  if (storageDeposit <= 0n) throw new Error("Factory deposit must be greater than zero");
  return [
    {
      signerId,
      receiverId: factoryId,
      actions: [{
        type: "FunctionCall",
        receiverId: factoryId,
        methodName: "create_token",
        args: { args },
        gas: CREATE_TOKEN_GAS,
        deposit: storageDeposit
      }]
    },
    buildMintFeeTransaction(signerId)
  ];
}

export function buildMintFeeTransaction(signerId: string): SignAndSendRequest {
  return {
    signerId,
    receiverId: TOKEN_TOOL_FEE_RECIPIENT,
    actions: [{
      type: "Transfer",
      receiverId: TOKEN_TOOL_FEE_RECIPIENT,
      deposit: getTokenToolFee("mint")
    }]
  };
}
