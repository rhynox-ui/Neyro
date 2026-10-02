import { withRpcFallback } from "../near/rpc.js";
import { safeUrl, type NearMarket } from "../market/dexscreener.js";
import { dclPriceInQuote, fetchDclPool, toUnits, type DclPool } from "../market/dcl.js";

const WRAPPED_NEAR = "wrap.near";
const NEAR_DECIMALS = 24;
/** Every NEARly launch token uses 18 decimals (TOKEN_DECIMALS in the factory). */
export const NEARLY_TOKEN_DECIMALS = 18;

/**
 * NEARly (nearly.trade) factory. Every launch mints its whole supply into a
 * single-sided RHEA DCL position, so tokens trade from the block they are
 * created; the factory's view methods are the launch feed.
 */
export const NEARLY_FACTORY = "nearlytrade.near";

export type NearlyLaunch = {
  id: number;
  token: string;
  name: string;
  symbol: string;
  creator: string;
  createdAtMs: number;
  /** The pair's other asset: wrap.near or another token such as NEARLY. */
  quote: string;
  links: { label: string; url: string }[];
  /** RHEA DCL pool holding the launch liquidity, e.g. "token|wrap.near|10000". */
  poolId?: string;
  /** DCL orders pairs lexicographically; decides which side the price is for. */
  tokenIsX?: boolean;
  /** Raw total supply (1B tokens at 18 decimals for NEARly launches). */
  totalSupply?: string;
  /** Immutable NEARly launch tax, when configured. */
  tax?: { buyBps: number; sellBps: number };
};

type RawLaunch = {
  id?: unknown;
  token?: unknown;
  name?: unknown;
  symbol?: unknown;
  creator?: unknown;
  created_at_ms?: unknown;
  quote?: unknown;
  step?: unknown;
  pool_id?: unknown;
  token_is_x?: unknown;
  total_supply?: unknown;
  links?: { website?: unknown; twitter?: unknown; telegram?: unknown };
};

function parseLaunch(raw: RawLaunch): NearlyLaunch | null {
  // Only completed launches have a funded pool; others may still fail.
  if (raw.step !== "Done") return null;
  if (typeof raw.token !== "string" || typeof raw.symbol !== "string") return null;
  const id = Number(raw.id);
  if (!Number.isSafeInteger(id) || id < 0) return null;

  const links = [
    ["Website", raw.links?.website],
    ["X", raw.links?.twitter],
    ["Telegram", raw.links?.telegram]
  ].flatMap(([label, value]) => {
    const url = safeUrl(value);
    return url ? [{ label: label as string, url }] : [];
  });

  return {
    id,
    token: raw.token,
    name: String(raw.name ?? raw.symbol).slice(0, 48),
    symbol: raw.symbol.slice(0, 24),
    creator: String(raw.creator ?? ""),
    createdAtMs: Number(raw.created_at_ms) || 0,
    quote: typeof raw.quote === "string" ? raw.quote : "wrap.near",
    links,
    ...(typeof raw.pool_id === "string" ? { poolId: raw.pool_id } : {}),
    ...(typeof raw.token_is_x === "boolean" ? { tokenIsX: raw.token_is_x } : {}),
    ...(typeof raw.total_supply === "string" && /^\d+$/.test(raw.total_supply) ? { totalSupply: raw.total_supply } : {})
  };
}

export function parseLaunches(json: unknown): NearlyLaunch[] {
  if (!Array.isArray(json)) throw new Error("Invalid get_launches response");
  return json.flatMap((raw) => {
    const launch = raw && typeof raw === "object" ? parseLaunch(raw as RawLaunch) : null;
    return launch ? [launch] : [];
  });
}

/** Newest completed launches first. */
export async function fetchRecentLaunches(limit = 8): Promise<NearlyLaunch[]> {
  // Fetch a few extra: in-flight or failed launches are filtered out.
  const raw = await withRpcFallback((provider) => provider.callFunction({
    contractId: NEARLY_FACTORY,
    method: "get_launches",
    args: { from_index: 0, limit: Math.min(limit * 2, 50) }
  }));
  return parseLaunches(raw).slice(0, limit);
}

export async function fetchLaunch(id: number): Promise<NearlyLaunch | null> {
  const raw = await withRpcFallback((provider) => provider.callFunction({
    contractId: NEARLY_FACTORY,
    method: "get_launch",
    args: { launch_id: String(id) }
  }));
  return raw && typeof raw === "object" ? parseLaunch(raw as RawLaunch) : null;
}

export function isNearlyToken(contractId: string): boolean {
  return contractId.endsWith(`.${NEARLY_FACTORY}`);
}

async function fetchLaunchTax(id: number): Promise<{ buyBps: number; sellBps: number } | undefined> {
  const raw = await withRpcFallback((provider) => provider.callFunction({
    contractId: NEARLY_FACTORY,
    method: "get_tax",
    args: { launch_id: String(id) }
  })).catch(() => null);
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const buy = value.buy_bps;
  const sell = value.sell_bps;
  if (
    !Number.isInteger(buy) || !Number.isInteger(sell) ||
    buy < 0 || buy > 400 || sell < 0 || sell > 400
  ) return undefined;
  return { buyBps: buy, sellBps: sell };
}

export async function fetchLaunchByToken(token: string): Promise<NearlyLaunch | null> {
  const raw = await withRpcFallback((provider) => provider.callFunction({
    contractId: NEARLY_FACTORY,
    method: "get_launch_by_token",
    args: { token }
  }));
  const launch = raw && typeof raw === "object" ? parseLaunch(raw as RawLaunch) : null;
  if (!launch) return null;
  const tax = await fetchLaunchTax(launch.id);
  return tax ? { ...launch, tax } : launch;
}

/**
 * Minimal market card from the factory's own launch record, for tokens
 * too new to have a DexScreener pair. Prices stay unknown.
 */
export function launchAsMarket(launch: NearlyLaunch): NearMarket {
  return {
    address: launch.token,
    name: launch.name,
    symbol: launch.symbol,
    dex: "rhea · NEARly",
    pairLabel: `${launch.symbol} / ${launch.quote === "wrap.near" ? "NEAR" : launch.quote.split(".")[0]!.toUpperCase()}`,
    url: `https://dexscreener.com/near/${encodeURIComponent(launch.token)}`,
    priceUsd: null,
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    priceChange24hPct: null,
    txns24hBuys: null,
    txns24hSells: null,
    pairCreatedAtMs: launch.createdAtMs || null,
    imageUrl: null,
    links: launch.links
  };
}

export type LaunchPricing = {
  /** USD per whole token, when the quote side has a USD price. */
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
};

/**
 * Prices a NEARly token from its own RHEA DCL pool: the pool's current point
 * gives the price in the quote asset, and wNEAR (or a NEARly quote token,
 * priced the same way, one level deep) converts it to USD.
 */
export function priceLaunch(
  launch: Pick<NearlyLaunch, "quote" | "tokenIsX" | "totalSupply">,
  pool: DclPool,
  quoteUsd: number | null,
  quoteDecimals: number,
  tokenDecimals = NEARLY_TOKEN_DECIMALS
): LaunchPricing {
  const tokenIsX = launch.tokenIsX ?? true;
  const priceInQuote = dclPriceInQuote(pool.currentPoint, tokenIsX, tokenDecimals, quoteDecimals);
  if (!quoteUsd || !Number.isFinite(priceInQuote)) return { priceUsd: null, liquidityUsd: null, marketCapUsd: null };

  const priceUsd = priceInQuote * quoteUsd;
  const tokenReserve = toUnits(tokenIsX ? pool.totalX : pool.totalY, tokenDecimals);
  const quoteReserve = toUnits(tokenIsX ? pool.totalY : pool.totalX, quoteDecimals);
  const supply = launch.totalSupply ? toUnits(BigInt(launch.totalSupply), tokenDecimals) : null;
  return {
    priceUsd,
    liquidityUsd: tokenReserve * priceUsd + quoteReserve * quoteUsd,
    marketCapUsd: supply !== null ? supply * priceUsd : null
  };
}

/** USD price of one whole NEARly token from its pool, or null. */
export async function nearlyPriceUsd(launch: NearlyLaunch, nearUsd: number | null, depth = 0): Promise<LaunchPricing | null> {
  if (!launch.poolId) return null;
  const pool = await fetchDclPool(launch.poolId);
  if (!pool) return null;

  let quoteUsd: number | null = null;
  let quoteDecimals = NEAR_DECIMALS;
  if (launch.quote === WRAPPED_NEAR) {
    quoteUsd = nearUsd;
  } else if (isNearlyToken(launch.quote) && depth === 0) {
    // Memes paired with another NEARly token (e.g. NEARLY) are priced through it.
    quoteDecimals = NEARLY_TOKEN_DECIMALS;
    const quoteLaunch = await fetchLaunchByToken(launch.quote);
    quoteUsd = quoteLaunch ? (await nearlyPriceUsd(quoteLaunch, nearUsd, depth + 1))?.priceUsd ?? null : null;
  }
  return priceLaunch(launch, pool, quoteUsd, quoteDecimals);
}

/** Market card from the launch record plus on-chain pool pricing. */
export async function nearlyMarket(launch: NearlyLaunch, nearUsd: number | null): Promise<NearMarket> {
  const base = launchAsMarket(launch);
  const pricing = await nearlyPriceUsd(launch, nearUsd).catch((error) => {
    console.warn("NEARly pool pricing failed:", { token: launch.token, error: String(error) });
    return null;
  });
  if (!pricing) return base;
  return {
    ...base,
    priceUsd: pricing.priceUsd !== null ? String(pricing.priceUsd) : null,
    marketCapUsd: pricing.marketCapUsd,
    fdvUsd: pricing.marketCapUsd,
    liquidityUsd: pricing.liquidityUsd
  };
}
