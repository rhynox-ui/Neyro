import { formatUnits, parseUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import type { NearTransaction } from "@rhea-finance/cross-chain-aggregation-dex";
import { config } from "../config.js";
import { getNearBalance } from "../near/account.js";
import { functionCall } from "../near/actions.js";
import { createFailoverProvider, withRpcFallback } from "../near/rpc.js";
import { lookupTransaction } from "../near/execution.js";
import { defaultStateStore } from "../state/store.js";
import { NearAccountSigner } from "../wallet/near-account-signer.js";
import type { WalletService } from "../wallet/service.js";
import { UserFacingError } from "../errors.js";

export const NEARLY_FACTORY = "nearlytrade.near";
export const NEARLY_WNEAR = "wrap.near";
const LAUNCH_GAS = 300_000_000_000_000n;
const LAUNCH_TTL_MS = 60_000;
const POLL_MS = 2_000;

type LaunchCost = {
  launch_fee: string;
  token_storage: string;
  pool_create: string;
  dcl_storage: string;
  dev_buy: string;
  total: string;
};

type LaunchRecord = {
  id: number;
  token: string;
  creator: string;
  name: string;
  symbol: string;
  step: string;
  inflight: boolean;
  quote: string;
  total_supply: string;
  pool_id: string;
};

export type NearlyLaunchInput = {
  name: string;
  symbol: string;
  description?: string;
  icon?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  devBuyNear?: string;
};

export type NearlyLaunchResult = {
  txHash: string;
  launch: LaunchRecord;
  cost: LaunchCost;
  devBuyNear: string;
};

export type NearlyLaunchPending = {
  txHash: string;
  symbol: string;
  creator: string;
  startedAt: number;
};

export type NearlyLaunchRecovery = "live" | "failed" | "processing" | "unknown" | "reverted";

function cleanOptional(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function validateHttpsUrl(value: string | undefined, field: string): string | undefined {
  const v = cleanOptional(value);
  if (!v) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new UserFacingError(`${field} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new UserFacingError(`${field} must use HTTPS without embedded credentials`);
  }
  if (v.length > 200) throw new UserFacingError(`${field} is too long (max 200 characters)`);
  return v;
}

function validateIcon(value: string | undefined): string | undefined {
  const v = cleanOptional(value);
  if (!v) return undefined;
  if (!(v.startsWith("https://") || v.startsWith("ipfs://"))) {
    throw new UserFacingError("Logo must be an https:// or ipfs:// URL");
  }
  const bytes = new TextEncoder().encode(v).byteLength;
  if (bytes > 16 * 1024) throw new UserFacingError("Logo URL is too large for NEARly's 16 KB metadata limit");
  return v;
}

function validateInput(input: NearlyLaunchInput): Required<Pick<NearlyLaunchInput, "name" | "symbol">> & Omit<NearlyLaunchInput, "name" | "symbol"> {
  const name = input.name.trim();
  const symbol = input.symbol.trim().toUpperCase();
  if (name.length < 1 || name.length > 32) throw new UserFacingError("Name must be 1–32 characters");
  if (symbol.length < 1 || symbol.length > 10 || !/^[A-Z0-9]+$/.test(symbol)) {
    throw new UserFacingError("Symbol must be 1–10 ASCII letters/digits");
  }
  const description = cleanOptional(input.description);
  if (description && description.length > 500) throw new UserFacingError("Description must be at most 500 characters");
  const icon = validateIcon(input.icon);
  const website = validateHttpsUrl(input.website, "Website");
  const twitter = validateHttpsUrl(input.twitter, "X");
  const telegram = validateHttpsUrl(input.telegram, "Telegram");

  return {
    ...input,
    name,
    symbol,
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(website ? { website } : {}),
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {})
  };
}

function launchArgs(input: ReturnType<typeof validateInput>, devBuyYocto: bigint): Record<string, unknown> {
  const links = {
    ...(input.website ? { website: input.website } : {}),
    ...(input.twitter ? { twitter: input.twitter } : {}),
    ...(input.telegram ? { telegram: input.telegram } : {})
  };
  return {
    name: input.name,
    symbol: input.symbol,
    icon: input.icon ?? null,
    description: input.description ?? null,
    links,
    dev_buy: devBuyYocto.toString(),
    quote: NEARLY_WNEAR
  };
}

async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return withRpcFallback((provider) => provider.callFunction({
    contractId: NEARLY_FACTORY,
    method,
    args
  })) as Promise<T>;
}

function parseCost(raw: unknown): LaunchCost {
  if (!raw || typeof raw !== "object") throw new UserFacingError("NEARly returned an invalid launch cost");
  const r = raw as Record<string, unknown>;
  const fields = ["launch_fee", "token_storage", "pool_create", "dcl_storage", "dev_buy", "total"] as const;
  const out = {} as LaunchCost;
  for (const field of fields) {
    const value = r[field];
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      throw new UserFacingError("NEARly returned an invalid launch cost");
    }
    out[field] = value;
  }
  return out;
}

function parseLaunch(raw: unknown): LaunchRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = Number(r.id);
  if (!Number.isSafeInteger(id) || id < 0) return null;
  if (typeof r.token !== "string" || typeof r.creator !== "string" || typeof r.symbol !== "string") return null;
  if (typeof r.step !== "string") return null;
  if (r.inflight !== undefined && typeof r.inflight !== "boolean") return null;
  if (r.quote !== undefined && typeof r.quote !== "string") return null;
  if (r.total_supply !== undefined && (typeof r.total_supply !== "string" || !/^\d+$/.test(r.total_supply))) return null;
  if (r.pool_id !== undefined && (typeof r.pool_id !== "string" || !r.pool_id.trim())) return null;
  return {
    id,
    token: r.token,
    creator: r.creator,
    name: typeof r.name === "string" ? r.name : r.symbol,
    symbol: r.symbol,
    step: r.step,
    inflight: r.inflight === true,
    quote: typeof r.quote === "string" ? r.quote : "",
    total_supply: typeof r.total_supply === "string" ? r.total_supply : "",
    pool_id: typeof r.pool_id === "string" ? r.pool_id : ""
  };
}

export async function getNearlyLaunchBySymbol(symbol: string): Promise<LaunchRecord | null> {
  return parseLaunch(await view("get_launch_by_symbol", { symbol }));
}

async function getLaunchBySymbol(symbol: string): Promise<LaunchRecord | null> {
  return getNearlyLaunchBySymbol(symbol);
}

export async function recoverNearlyLaunch(pending: NearlyLaunchPending): Promise<NearlyLaunchRecovery> {
  const tx = await lookupTransaction(createFailoverProvider(), pending.txHash, pending.creator);
  if (tx.result === "reverted") return "reverted";
  if (tx.result === "unknown") return "unknown";

  const launch = await getNearlyLaunchBySymbol(pending.symbol);
  if (!launch || launch.creator !== pending.creator || launch.symbol !== pending.symbol) return "processing";
  if (launch.step === "Failed") return "failed";
  if (isCompletedLaunch(launch, pending.symbol, pending.creator)) return "live";
  return "processing";
}

function isCompletedLaunch(launch: LaunchRecord, symbol: string, creator: string): boolean {
  return launch.symbol === symbol &&
    launch.creator === creator &&
    launch.step === "Done" &&
    !launch.inflight &&
    launch.quote === NEARLY_WNEAR &&
    launch.token.trim().length > 0 &&
    launch.pool_id.trim().length > 0 &&
    launch.total_supply.trim().length > 0;
}

async function waitForLaunch(symbol: string, creator: string): Promise<LaunchRecord> {
  const deadline = Date.now() + LAUNCH_TTL_MS;
  let last: LaunchRecord | null = null;
  while (Date.now() < deadline) {
    last = await getLaunchBySymbol(symbol);
    if (last && isCompletedLaunch(last, symbol, creator)) return last;
    if (last && last.creator === creator) {
      if (last.step === "Failed") {
        throw new UserFacingError(
          `NEARly launch ${last.id} was created but its on-chain launch pipeline failed. No automatic retry was performed. Use the NEARly launch recovery flow for launch #${last.id}.`
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (last && last.creator === creator) {
    throw new UserFacingError(
      `Launch transaction confirmed, but NEARly launch #${last.id} is still processing (step: ${last.step}). No duplicate launch was submitted. Check the launch again later.`
    );
  }
  throw new UserFacingError("Launch transaction confirmed, but NEARly has not indexed the new launch yet. No duplicate launch was submitted.");
}

export async function launchNearlyToken(
  walletService: WalletService,
  userId: number,
  input: NearlyLaunchInput
): Promise<NearlyLaunchResult> {
  if (config.NEAR_NETWORK !== "mainnet") {
    throw new UserFacingError("NEARly launches are available on NEAR mainnet only");
  }

  const wallet = await walletService.getWallet(userId);
  if (!wallet) throw new UserFacingError("Create a Neyro wallet first with /wallet");

  const clean = validateInput(input);
  const iconBytes = clean.icon ? new TextEncoder().encode(clean.icon).byteLength : 0;

  const pending = await defaultStateStore().get<NearlyLaunchPending>(userId, "launch-pending");
  if (pending) {
    const recovered = await recoverNearlyLaunch(pending);
    if (recovered === "live") {
      await defaultStateStore().delete(userId, "launch-pending");
      throw new UserFacingError(
        `Your previous NEARly launch is already LIVE (transaction ${pending.txHash}). Do not submit another launch.`
      );
    }
    if (recovered === "failed" || recovered === "reverted") {
      await defaultStateStore().delete(userId, "launch-pending");
    } else {
      throw new UserFacingError(
        `A previous NEARly launch is still pending (transaction ${pending.txHash}). Do not launch again. Use /launch-status to reconcile it first.`
      );
    }
  }

  let devBuy = 0n;
  const requested = cleanOptional(clean.devBuyNear);
  if (requested) {
    if (!/^\d+(?:\.\d+)?$/.test(requested)) {
      throw new UserFacingError("First buy must be a positive NEAR amount");
    }
    try {
      devBuy = BigInt(parseUnits(requested, 24));
      if (devBuy <= 0n) throw new Error("non-positive");
    } catch {
      throw new UserFacingError("First buy has too many decimal places");
    }
  }

  const capRaw = await view<unknown>("get_dev_buy_cap", {});
  const cap = typeof capRaw === "string" && /^\d+$/.test(capRaw)
    ? BigInt(capRaw)
    : (() => { throw new UserFacingError("NEARly returned an invalid first-buy cap"); })();
  if (devBuy > cap) {
    throw new UserFacingError(
      `First buy exceeds NEARly's current cap of ${formatUnits(cap.toString(), 24)} NEAR. Lower the first buy and retry.`
    );
  }

  const cost = parseCost(await view("quote_launch", {
    icon_bytes: iconBytes,
    dev_buy: devBuy.toString()
  }));

  const balance = await getNearBalance(wallet.accountId);
  const required = BigInt(cost.total);
  if (balance.available < required + BigInt(config.NEAR_SPENDABLE_RESERVE_YOCTO)) {
    throw new UserFacingError(
      `Not enough spendable NEAR. Launch requires ${formatUnits(required.toString(), 24)} NEAR and Neyro keeps ${formatUnits(config.NEAR_SPENDABLE_RESERVE_YOCTO, 24)} NEAR reserved for gas/storage.`
    );
  }

  const account = await walletService.getSigningAccount(userId, wallet.accountId);
  const signer = new NearAccountSigner(account, {
    allowedReceivers: [NEARLY_FACTORY],
    beforeBroadcast: async (txHash) => {
      await defaultStateStore().set(userId, "launch-pending", {
        txHash,
        symbol: clean.symbol,
        creator: wallet.accountId,
        startedAt: Date.now()
      } satisfies NearlyLaunchPending, 30 * 24 * 60 * 60 * 1000);
    }
  });

  const tx: NearTransaction = {
    receiverId: NEARLY_FACTORY,
    actions: [
      functionCall(
        "launch",
        launchArgs(clean, devBuy),
        LAUNCH_GAS,
        required
      )
    ]
  };

  let sent: Awaited<ReturnType<NearAccountSigner["signAndSendTransactions"]>>;
  try {
    sent = await signer.signAndSendTransactions([tx], {});
  } catch (error) {
    // The transaction may have been broadcast even when the RPC response was
    // lost. Reconcile before telling the user to retry: a retry could create
    // a second real token.
    await signer.reconcile();
    const record = signer.sent.at(-1);
    if (!record || record.receiverId !== NEARLY_FACTORY) throw error;
    if (record.result === "executed") {
      sent = { txHashes: [record.txHash], raw: [] };
    } else if (record.result === "reverted") {
      throw new UserFacingError(
        `NEARly launch transaction ${record.txHash} was reverted. No retry was submitted.`
      );
    } else if (record.result === "rejected") {
      await defaultStateStore().delete(userId, "launch-pending");
      throw error;
    } else {
      throw new UserFacingError(
        `NEARly launch submission is uncertain (transaction ${record.txHash}). Do not retry yet; check the transaction before submitting another launch.`
      );
    }
  }

  if (sent.txHashes.length !== 1) {
    throw new UserFacingError("NEARly launch did not produce a transaction hash; no duplicate launch was submitted.");
  }

  const record = await waitForLaunch(clean.symbol, wallet.accountId);
  await defaultStateStore().delete(userId, "launch-pending");
  return {
    txHash: sent.txHashes[0]!,
    launch: record,
    cost,
    devBuyNear: formatUnits(devBuy.toString(), 24)
  };
}
