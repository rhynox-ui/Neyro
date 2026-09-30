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
/** NEARLY's current native token. */
export const NEARLY_TOKEN = "nearly-993927.nearlytrade.near";
export const NEARLY_DEFAULT_QUOTE = NEARLY_WNEAR;
const LAUNCH_GAS = 300_000_000_000_000n;
const QUOTE_CACHE_MS = 30_000;

export type NearlyQuote = {
  accountId: string;
  symbol: string;
  decimals: number;
};

const KNOWN_QUOTE_SYMBOLS: Record<string, string> = {
  [NEARLY_WNEAR]: "NEAR",
  [NEARLY_TOKEN]: "NEARLY",
  "token.rhealab.near": "RHEA",
  "zec.omft.near": "ZEC",
  "kat.token0.near": "KAT",
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "USDC",
  "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near": "BTC",
  "eth.bridge.near": "ETH"
};

let quoteCache: { expiresAt: number; quotes: NearlyQuote[] } | undefined;
const LAUNCH_TTL_MS = 60_000;
const POLL_MS = 2_000;

export type LaunchCost = {
  launch_fee: string;
  token_storage: string;
  pool_create: string;
  dcl_storage: string;
  dev_buy: string;
  total: string;
};

export type LaunchRecord = {
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
  /** Quote asset used for the RHEA launch pair. */
  quote?: string;
  /** Immutable NEARly token tax configuration. Values are basis points. */
  tax?: {
    buyBps: number;
    sellBps: number;
    creatorBps: number;
    burnBps: number;
    holdersBps: number;
  };
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

/** Persisted record of a successfully completed NEARly launch. */
export type NearlyLaunchHistoryEntry = {
  txHash: string;
  launch: LaunchRecord;
  cost: LaunchCost;
  devBuyNear: string;
  completedAt: number;
};

const LAUNCH_HISTORY_KEY = "launch-history";
const LAUNCH_HISTORY_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_LAUNCH_HISTORY = 20;

export async function saveNearlyLaunchHistory(userId: number, result: NearlyLaunchResult): Promise<void> {
  const store = defaultStateStore();
  const existing = await store.get<NearlyLaunchHistoryEntry[]>(userId, LAUNCH_HISTORY_KEY) ?? [];
  const entry: NearlyLaunchHistoryEntry = {
    txHash: result.txHash,
    launch: result.launch,
    cost: result.cost,
    devBuyNear: result.devBuyNear,
    completedAt: Date.now()
  };
  const history = [entry, ...existing.filter((item) => item.txHash !== entry.txHash)].slice(0, MAX_LAUNCH_HISTORY);
  await store.set(userId, LAUNCH_HISTORY_KEY, history, LAUNCH_HISTORY_TTL_MS);
}

export async function getNearlyLaunchHistory(userId: number, limit = 10): Promise<NearlyLaunchHistoryEntry[]> {
  const history = await defaultStateStore().get<NearlyLaunchHistoryEntry[]>(userId, LAUNCH_HISTORY_KEY) ?? [];
  return history.slice(0, Math.max(1, Math.min(limit, MAX_LAUNCH_HISTORY)));
}

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
  if (!(v.startsWith("https://") || v.startsWith("ipfs://") || v.startsWith("data:image/"))) {
    throw new UserFacingError("Logo must be an HTTPS, IPFS, or uploaded image");
  }
  if (v.startsWith("data:image/")) {
    const comma = v.indexOf(",");
    if (comma < 0) throw new UserFacingError("Uploaded logo data is invalid");
    const base64 = v.slice(comma + 1);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new UserFacingError("Uploaded logo data is invalid");
    // NEARly's factory measures the stored Rust String in bytes, including
    // the data:image/ prefix and base64 text. Checking decoded image bytes
    // here is insufficient because base64 expands the stored representation.
    if (new TextEncoder().encode(v).byteLength > 16 * 1024) {
      throw new UserFacingError("Logo is too large for NEARly's 16 KB on-chain metadata limit. Send a smaller image.");
    }
  } else if (new TextEncoder().encode(v).byteLength > 16 * 1024) {
    throw new UserFacingError("Logo URL is too large for NEARly's 16 KB metadata limit");
  }
  return v;
}

function quoteAccount(raw: Record<string, unknown>): string | undefined {
  for (const key of ["token", "account_id", "accountId", "contract", "asset"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) return raw[key].trim();
  }
  return undefined;
}

function quoteDecimalsValue(raw: Record<string, unknown>): number {
  const value = raw.decimals;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 36) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 36) return parsed;
  }
  return 24;
}

function quoteSymbol(raw: Record<string, unknown>, accountId: string): string {
  for (const key of ["symbol", "ticker", "name"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) return raw[key].trim().toUpperCase();
  }
  return KNOWN_QUOTE_SYMBOLS[accountId] ?? accountId.split(".")[0]!.toUpperCase();
}

function parseQuotes(raw: unknown): NearlyQuote[] {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  const container = Array.isArray(raw) ? raw
    : root && root.quotes !== undefined ? root.quotes
    : root && root.pairs !== undefined ? root.pairs
    : undefined;

  const source: Array<{ key?: string; value: unknown }> = Array.isArray(container)
    ? container.map((value) => ({ value }))
    : container && typeof container === "object"
      ? Object.entries(container).map(([key, value]) => ({ key, value }))
      : [];

  if (source.length === 0) throw new UserFacingError("NEARly returned an invalid pair list");

  const quotes = source.flatMap(({ key, value }: { key?: string; value: unknown }) => {
    // near-sdk serializes Vec<(AccountId, QuoteAsset)> as tuple arrays:
    // [["wrap.near", { decimals, ... }], ...]. Also accept object-shaped
    // responses so this stays compatible with older/newer factory versions.
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
      const accountId = value[0].trim();
      const rawItem = value[1];
      if (!accountId || !rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return [];
      const item = rawItem as Record<string, unknown>;
      return [{ accountId, symbol: quoteSymbol(item, accountId), decimals: quoteDecimalsValue(item) }];
    }
    if (typeof value === "string") {
      const accountId = value;
      return [{ accountId, symbol: KNOWN_QUOTE_SYMBOLS[accountId] ?? accountId.split(".")[0]!.toUpperCase(), decimals: accountId === NEARLY_TOKEN ? 18 : 24 }];
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const rawItem = value as Record<string, unknown>;
    const accountId = quoteAccount(rawItem) ?? (key && key.includes(".") ? key : undefined);
    if (!accountId) return [];
    return [{ accountId, symbol: quoteSymbol(rawItem, accountId), decimals: quoteDecimalsValue(rawItem) }];
  });

  const unique = new Map<string, NearlyQuote>();
  for (const quote of quotes) unique.set(quote.accountId, quote);
  const result = [...unique.values()].sort((a, b) =>
    Number(b.accountId === NEARLY_WNEAR) - Number(a.accountId === NEARLY_WNEAR)
  );
  if (!result.some((quote) => quote.accountId === NEARLY_WNEAR)) {
    throw new UserFacingError("NEARly pair data did not include the default NEAR pair");
  }
  return result;
}

export async function getNearlyQuotes(forceRefresh = false): Promise<readonly NearlyQuote[]> {
  if (!forceRefresh && quoteCache && quoteCache.expiresAt > Date.now()) return quoteCache.quotes;
  const quotes = parseQuotes(await view<unknown>("get_quotes", {}));
  quoteCache = { expiresAt: Date.now() + QUOTE_CACHE_MS, quotes };
  return quotes;
}

function validateQuote(value: string | undefined, quotes: readonly NearlyQuote[]): string {
  const quote = cleanOptional(value) ?? NEARLY_DEFAULT_QUOTE;
  if (!quotes.some((item) => item.accountId === quote)) {
    throw new UserFacingError("That NEARly launch pair is not currently approved");
  }
  return quote;
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
  const quote = cleanOptional(input.quote) ?? NEARLY_DEFAULT_QUOTE;
  const tax = input.tax;
  if (tax) {
    const bps = [tax.buyBps, tax.sellBps, tax.creatorBps, tax.burnBps, tax.holdersBps];
    if (!bps.every((value) => Number.isInteger(value) && value >= 0)) {
      throw new UserFacingError("Tax settings must be whole-number basis points");
    }
    if (tax.buyBps > 400 || tax.sellBps > 400) {
      throw new UserFacingError("NEARly tax cannot exceed 4% on either side");
    }
    if (tax.creatorBps + tax.burnBps + tax.holdersBps !== 10_000) {
      throw new UserFacingError("NEARly tax destinations must total 100%");
    }
  }

  return {
    ...input,
    name,
    symbol,
    quote,
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(website ? { website } : {}),
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {}),
    ...(tax ? { tax } : {})
  };
}

function iconByteLength(icon: string | undefined): number {
  if (!icon) return 0;
  // The factory charges quote_launch against the UTF-8 byte length of the
  // serialized icon string (Rust String::len()), not the decoded image bytes.
  return new TextEncoder().encode(icon).byteLength;
}

/**
 * NEARly's quote_launch expects icon_bytes to include the UTF-8 byte length
 * of the icon string plus the name, symbol and description text.
 */
export function launchQuoteBytes(input: Pick<NearlyLaunchInput, "name" | "symbol" | "description" | "icon">): number {
  const text = input.name + input.symbol + (input.description ?? "");
  return iconByteLength(input.icon) + new TextEncoder().encode(text).byteLength;
}
function launchArgs(input: ReturnType<typeof validateInput>, devBuyYocto: bigint): Record<string, unknown> {
  const links = {
    ...(input.website ? { website: input.website } : {}),
    ...(input.twitter ? { twitter: input.twitter } : {}),
    ...(input.telegram ? { telegram: input.telegram } : {})
  };

  // NEARly treats optional LaunchArgs fields semantically:
  // - quote is omitted for the default NEAR pair
  // - dev_buy is omitted unless a real first buy was requested
  // Sending dev_buy: "0" on a non-NEAR pair is not equivalent to omitting it;
  // the factory rejects any dev_buy supplied for a non-NEAR pair.
  return {
    name: input.name,
    symbol: input.symbol,
    icon: input.icon ?? null,
    description: input.description ?? null,
    links,
    ...(devBuyYocto > 0n ? { dev_buy: devBuyYocto.toString() } : {}),
    ...(input.quote && input.quote !== NEARLY_WNEAR ? { quote: input.quote } : {}),
    creator_share_bps: 8000,
    ...(input.tax ? {
      tax: {
        buy_bps: input.tax.buyBps,
        sell_bps: input.tax.sellBps,
        creator_bps: input.tax.creatorBps,
        burn_bps: input.tax.burnBps,
        holders_bps: input.tax.holdersBps
      }
    } : {})
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
    inflight: r.inflight ?? false,
    quote: r.quote ?? NEARLY_WNEAR,
    total_supply: r.total_supply ?? "0",
    pool_id: r.pool_id ?? ""
  };
}

async function findLaunch(symbol: string, creator: string): Promise<LaunchRecord | null> {
  const bySymbol = await view<unknown>("get_launch_by_symbol", { symbol }).catch(() => null);
  const direct = parseLaunch(bySymbol);
  if (direct && direct.creator === creator && direct.symbol === symbol) return direct;

  const countRaw = await view<unknown>("get_num_launches", {}).catch(() => null);
  const count = typeof countRaw === "number"
    ? countRaw
    : typeof countRaw === "string" && /^\\d+$/.test(countRaw) ? Number(countRaw) : null;
  if (count !== null && Number.isSafeInteger(count) && count >= 0) {
    const fromIndex = Math.max(0, count - 100);
    const raw = await view<unknown>("get_launches", { from_index: fromIndex, limit: 100 }).catch(() => null);
    if (Array.isArray(raw)) {
      const match = raw.map((item) => parseLaunch(item))
        .find((item) => item?.creator === creator && item.symbol === symbol);
      if (match) return match;
    }
  }

  const raw = await view<unknown>("get_launches", { from_index: 0, limit: 50 }).catch(() => null);
  if (Array.isArray(raw)) {
    return raw.map((item) => parseLaunch(item))
      .find((item) => item?.creator === creator && item.symbol === symbol) ?? null;
  }
  return null;
}

async function waitForLaunch(symbol: string, creator: string): Promise<LaunchRecord> {
  const deadline = Date.now() + LAUNCH_TTL_MS;
  while (Date.now() < deadline) {
    const match = await findLaunch(symbol, creator);
    if (match?.step === "Done") return match;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new UserFacingError("Launch transaction confirmed, but NEARly has not indexed the new launch yet. No duplicate launch was submitted.");
}

export async function recoverNearlyLaunch(pending: NearlyLaunchPending): Promise<NearlyLaunchRecovery> {
  const status = await withRpcFallback((provider) => lookupTransaction(provider, pending.txHash, pending.creator)).catch(() => null);
  if (!status) return "unknown";
  if (status.result === "reverted") return "reverted";
  if (status.result === "unknown") return "unknown";
  const deadline = Date.now() + LAUNCH_TTL_MS;
  while (Date.now() < deadline) {
    const match = await findLaunch(pending.symbol, pending.creator);
    if (match?.step === "Done") return "live";
    if (match?.inflight) return "processing";
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return "unknown";
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
  const quotes = await getNearlyQuotes();
  const quote = validateQuote(clean.quote, quotes);
  const iconBytes = launchQuoteBytes(clean);

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
  if (requested && quote !== NEARLY_WNEAR) {
    throw new UserFacingError("NEARly first buys are available only on the NEAR pair");
  }
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

  if (devBuy > 0n) {
    const capRaw = await view<unknown>("get_dev_buy_cap", {});
    const cap = typeof capRaw === "string" && /^\d+$/.test(capRaw)
      ? BigInt(capRaw)
      : (() => { throw new UserFacingError("NEARly returned an invalid first-buy cap"); })();
    if (devBuy > cap) {
      throw new UserFacingError(
        `First buy exceeds NEARly's current cap of ${formatUnits(cap.toString(), 24)} NEAR. Lower the first buy and retry.`
      );
    }
  }

  const cost = parseCost(await view("quote_launch", {
    icon_bytes: iconBytes,
    dev_buy: devBuy.toString(),
    tax: Boolean(clean.tax)
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
        { args: launchArgs(clean, devBuy) },
        LAUNCH_GAS,
        required
      )
    ]
  };

  let sent: Awaited<ReturnType<NearAccountSigner["signAndSendTransactions"]>>;
  try {
    sent = await signer.signAndSendTransactions([tx], {});
  } catch (error) {
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

  // sendTransactionUntil can return a receipt even when a receipt-level
  // execution failed. Do not wait 60s for indexing in that case; surface the
  // actual on-chain failure and clear the pending guard so the user can retry.
  const sentRecord = signer.sent.at(-1);
  if (sentRecord?.result === "reverted") {
    await defaultStateStore().delete(userId, "launch-pending");
    throw new UserFacingError(
      `NEARly launch transaction ${sentRecord.txHash} reverted: ${sentRecord.failure ?? "execution failed"}`
    );
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

export function launchQuoteLabel(quote: string | undefined): string {
  if (!quote || quote === NEARLY_WNEAR) return "NEAR";
  return KNOWN_QUOTE_SYMBOLS[quote] ?? quote.split(".")[0]!.toUpperCase();
}
