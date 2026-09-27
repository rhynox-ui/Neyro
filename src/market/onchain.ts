import { withRpcFallback } from "../near/rpc.js";
import { ftMetadata } from "../near/ft.js";
import { priceLaunch } from "../discovery/nearly.js";
import { dclPriceInQuote, fetchDclPool, type DclPool } from "./dcl.js";
import type { NearMarket } from "./dexscreener.js";

export const LINEAR = "linear-protocol.near";

/**
 * Quote tokens a meme may be paired with on RHEA DCL. Launchpads such as
 * umbra.fun pair with LiNEAR (liquid-staked NEAR) instead of wNEAR.
 */
const QUOTES = [
  { id: "wrap.near", symbol: "NEAR", decimals: 24 },
  { id: LINEAR, symbol: "LINEAR", decimals: 24 }
] as const;
const FEE_TIERS = [100, 400, 2000, 10000];

/** DCL pool ids list the two tokens in sorted order, then the fee tier. */
export function dclPoolId(a: string, b: string, fee: number): string {
  return `${[a, b].sort().join("|")}|${fee}`;
}

/** NEAR per LiNEAR: the staking contract's own rate, else its wNEAR pool. */
export async function linearNearRate(): Promise<number | null> {
  const rate = await withRpcFallback((provider) =>
    provider.callFunction({ contractId: LINEAR, method: "ft_price", args: {} })
  ).then((raw) => Number(raw) / 1e24).catch(() => NaN);
  if (Number.isFinite(rate) && rate > 0) return rate;

  for (const fee of FEE_TIERS) {
    const pool = await fetchDclPool(dclPoolId(LINEAR, "wrap.near", fee)).catch(() => null);
    if (pool && pool.totalX > 0n && pool.totalY > 0n) {
      return dclPriceInQuote(pool.currentPoint, LINEAR < "wrap.near", 24, 24);
    }
  }
  return null;
}

type Candidate = { quote: (typeof QUOTES)[number]; poolId: string; pool: DclPool; tokenIsX: boolean };

/** Deepest DCL pool of `token` against NEAR or LiNEAR, by quote-side reserve. */
export async function findDclPool(token: string): Promise<Candidate | null> {
  const ids = QUOTES.filter((quote) => quote.id !== token)
    .flatMap((quote) => FEE_TIERS.map((fee) => ({ quote, poolId: dclPoolId(token, quote.id, fee) })));
  const found = await Promise.all(ids.map(async ({ quote, poolId }) => {
    const pool = await fetchDclPool(poolId).catch(() => null);
    return pool ? { quote, poolId, pool, tokenIsX: token < quote.id } : null;
  }));
  const quoteReserve = (c: Candidate) => (c.tokenIsX ? c.pool.totalY : c.pool.totalX);
  return found
    .filter((c): c is Candidate => c !== null && quoteReserve(c) > 0n)
    .sort((a, b) => (quoteReserve(b) > quoteReserve(a) ? 1 : quoteReserve(b) < quoteReserve(a) ? -1 : 0))[0] ?? null;
}

async function totalSupply(token: string): Promise<string | undefined> {
  const raw = await withRpcFallback((provider) =>
    provider.callFunction({ contractId: token, method: "ft_total_supply", args: {} })
  ).catch(() => undefined);
  return typeof raw === "string" && /^\d+$/.test(raw) ? raw : undefined;
}

/**
 * Live price, liquidity and market cap for any token with a RHEA DCL pool
 * against NEAR or LiNEAR, read straight from the chain. Used when every
 * market-data API is unavailable; it has no 24h stats. Null without a pool.
 */
export async function onchainMarket(token: string, nearUsd: number | null): Promise<NearMarket | null> {
  const [meta, found] = await Promise.all([ftMetadata(token).catch(() => null), findDclPool(token)]);
  if (!meta || !found) return null;

  const [supply, quoteNear] = await Promise.all([
    totalSupply(token),
    found.quote.id === LINEAR ? linearNearRate() : Promise.resolve(1)
  ]);
  const quoteUsd = nearUsd !== null && quoteNear !== null ? nearUsd * quoteNear : null;
  const pricing = priceLaunch(
    { quote: found.quote.id, tokenIsX: found.tokenIsX, totalSupply: supply },
    found.pool,
    quoteUsd,
    found.quote.decimals,
    meta.decimals
  );
  return {
    address: token,
    name: (meta.name ?? meta.symbol).slice(0, 48),
    symbol: meta.symbol.slice(0, 24),
    dex: "rhea",
    pairLabel: `${meta.symbol.slice(0, 24)} / ${found.quote.symbol}`,
    url: `https://dexscreener.com/near/${encodeURIComponent(token)}`,
    priceUsd: pricing.priceUsd !== null ? String(pricing.priceUsd) : null,
    marketCapUsd: pricing.marketCapUsd,
    fdvUsd: pricing.marketCapUsd,
    liquidityUsd: pricing.liquidityUsd,
    volume24hUsd: null,
    priceChange24hPct: null,
    txns24hBuys: null,
    txns24hSells: null,
    pairCreatedAtMs: null,
    imageUrl: null,
    links: [],
    onchain: true
  };
}
