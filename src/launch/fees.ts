import { formatUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import type { NearTransaction } from "@rhea-finance/cross-chain-aggregation-dex";
import { withRpcFallback } from "../near/rpc.js";
import { functionCall } from "../near/actions.js";
import { NearAccountSigner } from "../wallet/near-account-signer.js";
import type { WalletService } from "../wallet/service.js";
import { getNearlyQuotes, NEARLY_FACTORY, NEARLY_WNEAR } from "./nearly.js";
import { UserFacingError } from "../errors.js";

const CLAIM_GAS = 300_000_000_000_000n;
const PAGE_SIZE = 200;
const MAX_LAUNCHES_SCAN = 10_000;

type RawLaunch = {
  id: number;
  token: string;
  symbol: string;
  creator: string;
  quote: string;
  step: string;
  creator_token_fees: string;
  creator_quote_fees: string;
};

export type CreatorFeePosition = {
  launchId: number;
  token: string;
  symbol: string;
  quote: string;
  asset: string;
  amount: string;
  decimals: number;
  kind: "token" | "quote";
};

export type CreatorFeeSummary = {
  accountId: string;
  nearAmount: string;
  positions: CreatorFeePosition[];
};

export type CreatorFeeClaimKind = "near" | "token" | "quote";

function decimalString(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new UserFacingError(`NEARly returned an invalid ${field}`);
  }
  return value;
}

function optionalDecimalString(value: unknown): string {
  if (value === undefined || value === null || value === "") return "0";
  return typeof value === "string" && /^\d+$/.test(value) ? value : "0";
}

function parseLaunch(raw: unknown): RawLaunch | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "number" ? r.id : Number(r.id);
  if (!Number.isSafeInteger(id) || id < 0) return null;
  if (typeof r.token !== "string" || !r.token.trim()) return null;
  if (typeof r.symbol !== "string" || !r.symbol.trim()) return null;
  if (typeof r.creator !== "string" || !r.creator.trim()) return null;
  if (typeof r.step !== "string") return null;
  const quote = typeof r.quote === "string" && r.quote.trim() ? r.quote : NEARLY_WNEAR;
  return {
    id,
    token: r.token,
    symbol: r.symbol,
    creator: r.creator,
    quote,
    step: r.step,
    creator_token_fees: optionalDecimalString(r.creator_token_fees),
    creator_quote_fees: optionalDecimalString(r.creator_quote_fees)
  };
}

async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return withRpcFallback((provider) => provider.callFunction({
    contractId: NEARLY_FACTORY,
    method,
    args
  })) as Promise<T>;
}

async function getCreatorLaunches(accountId: string): Promise<RawLaunch[]> {
  const countRaw = await view<unknown>("get_num_launches", {});
  const countText = typeof countRaw === "bigint"
    ? countRaw.toString()
    : typeof countRaw === "number" && Number.isSafeInteger(countRaw)
      ? String(countRaw)
      : decimalString(countRaw, "launch count");
  const count = Number(countText);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_LAUNCHES_SCAN) {
    throw new UserFacingError("NEARly launch count is outside Neyro's safe scan limit");
  }

  const launches: RawLaunch[] = [];
  for (let fromIndex = 0; fromIndex < count; fromIndex += PAGE_SIZE) {
    const raw = await view<unknown>("get_launches", {
      from_index: fromIndex,
      limit: Math.min(PAGE_SIZE, count - fromIndex)
    });
    if (!Array.isArray(raw)) throw new UserFacingError("NEARly returned an invalid launch list");

    for (const item of raw) {
      const launch = parseLaunch(item);
      if (launch?.creator === accountId && launch.step === "Done") launches.push(launch);
    }
  }
  // get_launch is the documented source for per-launch creator fee fields.
  // Keep the broad discovery query separate from fee-state reads so this
  // feature does not depend on the shape of get_launches for fee accounting.
  const detailed: RawLaunch[] = [];
  for (const launch of launches) {
    const raw = await view<unknown>("get_launch", { launch_id: launch.id });
    const detail = parseLaunch(raw);
    if (detail && detail.creator === accountId && detail.step === "Done") detailed.push(detail);
  }
  return detailed;
}

export async function getCreatorFeeSummary(accountId: string): Promise<CreatorFeeSummary> {
  const [nearRaw, launches] = await Promise.all([
    view<unknown>("get_creator_fees", { account_id: accountId }),
    getCreatorLaunches(accountId)
  ]);

  const nearAmount = decimalString(nearRaw, "creator fee balance");
  const nonNearQuotes = launches.filter((launch) => launch.quote !== NEARLY_WNEAR);
  const decimalsByQuote = new Map(
    nonNearQuotes.length === 0
      ? []
      : (await getNearlyQuotes()).map((quote) => [quote.accountId, quote.decimals] as const)
  );

  const positions: CreatorFeePosition[] = [];
  for (const launch of launches) {
    const tokenAmount = launch.creator_token_fees;
    if (BigInt(tokenAmount) > 0n) {
      // NEARly launch tokens are fixed at 18 decimals.
      positions.push({
        launchId: launch.id,
        token: launch.token,
        symbol: launch.symbol,
        quote: launch.quote,
        asset: launch.token,
        amount: tokenAmount,
        decimals: 18,
        kind: "token"
      });
    }

    // NEAR-pair creator fees are represented by the aggregate get_creator_fees
    // balance. Do not duplicate that balance from creator_quote_fees.
    if (launch.quote !== NEARLY_WNEAR) {
      const quoteAmount = launch.creator_quote_fees;
      if (BigInt(quoteAmount) > 0n) {
        const decimals = decimalsByQuote.get(launch.quote);
        if (decimals === undefined) {
          throw new UserFacingError(`NEARly returned an unknown launch pair: ${launch.quote}`);
        }
        positions.push({
          launchId: launch.id,
          token: launch.token,
          symbol: launch.symbol,
          quote: launch.quote,
          asset: launch.quote,
          amount: quoteAmount,
          decimals,
          kind: "quote"
        });
      }
    }
  }

  return { accountId, nearAmount, positions };
}

function claimMethod(kind: CreatorFeeClaimKind): string {
  switch (kind) {
    case "near": return "claim_creator_fees";
    case "token": return "claim_creator_token_fees";
    case "quote": return "claim_creator_quote_fees";
  }
}

function claimArgs(kind: CreatorFeeClaimKind, launchId?: number): Record<string, unknown> {
  if (kind === "near") return {};
  if (!Number.isSafeInteger(launchId) || launchId === undefined || launchId < 0) {
    throw new UserFacingError("Invalid NEARly launch id");
  }
  return { launch_id: launchId };
}

export function buildCreatorFeeClaimTransaction(
  kind: CreatorFeeClaimKind,
  launchId?: number
): NearTransaction {
  const method = claimMethod(kind);
  const args = claimArgs(kind, launchId);
  return {
    receiverId: NEARLY_FACTORY,
    actions: [functionCall(method, args, CLAIM_GAS, 0n)]
  };
}

async function claim(
  walletService: WalletService,
  userId: number,
  accountId: string,
  kind: CreatorFeeClaimKind,
  launchId?: number
): Promise<string> {

  // Re-read the authoritative state immediately before signing. The UI is
  // never trusted for ownership or amount.
  if (kind === "near") {
    const amount = decimalString(await view<unknown>("get_creator_fees", { account_id: accountId }), "creator fee balance");
    if (BigInt(amount) <= 0n) throw new UserFacingError("No claimable NEAR creator fees right now");
  } else {
    const raw = await view<unknown>("get_launch", { launch_id: launchId });
    const launch = parseLaunch(raw);
    if (!launch || launch.creator !== accountId) {
      throw new UserFacingError("This launch does not belong to the active wallet");
    }
    const amount = kind === "token" ? launch.creator_token_fees : launch.creator_quote_fees;
    if (launch.quote === NEARLY_WNEAR && kind === "quote") {
      throw new UserFacingError("NEAR-pair creator fees are claimed through the aggregate NEAR balance");
    }
    if (BigInt(amount) <= 0n) throw new UserFacingError("No claimable creator fees for this launch right now");
  }

  const signer = new NearAccountSigner(
    await walletService.getSigningAccount(userId, accountId),
    { allowedReceivers: [NEARLY_FACTORY] }
  );
  const tx = buildCreatorFeeClaimTransaction(kind, launchId);

  try {
    const sent = await signer.signAndSendTransactions([tx], {});
    await signer.reconcile();
    const record = signer.sent.at(-1);
    if (!record || record.result !== "executed") {
      throw new UserFacingError(
        record?.result === "unknown"
          ? `Fee claim transaction ${record.txHash} is still uncertain. Do not retry yet.`
          : `NEARly fee claim did not confirm${record?.failure ? `: ${record.failure}` : "."}`
      );
    }
    return sent.txHashes[0] ?? record.txHash;
  } catch (error) {
    await signer.reconcile().catch(() => {});
    const record = signer.sent.at(-1);
    if (record?.result === "executed") return record.txHash;
    throw error;
  }
}

export async function claimCreatorNearFees(
  walletService: WalletService,
  userId: number,
  accountId: string
): Promise<string> {
  return claim(walletService, userId, accountId, "near");
}

export async function claimCreatorLaunchFees(
  walletService: WalletService,
  userId: number,
  accountId: string,
  kind: Exclude<CreatorFeeClaimKind, "near">,
  launchId: number
): Promise<string> {
  return claim(walletService, userId, accountId, kind, launchId);
}

export function formatCreatorFee(position: Pick<CreatorFeePosition, "amount" | "decimals">): string {
  return formatUnits(position.amount, position.decimals);
}
