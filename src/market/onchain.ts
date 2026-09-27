import { withRpcFallback } from "../near/rpc.js";
import { stripAssetPrefix } from "../rhea/client.js";
import { ftMetadata } from "../near/ft.js";
import { priceLaunch } from "../discovery/nearly.js";
import { dclPriceInQuote, fetchDclPool, toUnits } from "./dcl.js";
import { encodePool, fetchV2Reserves, poolsForToken, type PoolRef } from "./pools.js";
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

/** USD price and decimals of a pool's other token, or null when unknown. */
export type QuotePrice = { usd: number; decimals: number; symbol: string };
export type QuotePricer = (contractId: string) => Promise<QuotePrice | null>;

type ListedToken = { address: string; contractAddress?: string | null; decimals: number; symbol: string; price?: unknown };

/**
 * Quote prices from NEAR/USD, LiNEAR's staking rate and every token in
 * RHEA's list that carries a USD price.
 */
export function buildQuotePricer(tokens: readonly ListedToken[], nearUsd: number | null): QuotePricer {
  const listed = new Map<string, QuotePrice>();
  for (const token of tokens) {
    const usd = Number(token.price);
    const id = stripAssetPrefix(token.contractAddress ?? token.address);
    if (Number.isFinite(usd) && usd > 0 && id) listed.set(id, { usd, decimals: token.decimals, symbol: token.symbol });
  }
  let linear: Promise<number | null> | undefined;
  return async (contractId) => {
    if (contractId === "wrap.near") return nearUsd ? { usd: nearUsd, decimals: 24, symbol: "NEAR" } : null;
    if (contractId === LINEAR && nearUsd) {
      const rate = await (linear ??= linearNearRate());
      if (rate) return { usd: nearUsd * rate, decimals: 24, symbol: "LINEAR" };
    }
    return listed.get(contractId) ?? null;
  };
}

type Priced = { pool: PoolRef; quote: QuotePrice; priceUsd: number; liquidityUsd: number };

const MAX_POOLS_READ = 12;
/** Quotes most memes pair with; their pools are read first. */
const PREFERRED = new Set<string>(["wrap.near", LINEAR]);

/** Guessed DCL pools against NEAR/LiNEAR, so brand-new pools work before the index catches up. */
function guessedPools(token: string): PoolRef[] {
  return QUOTES.filter((quote) => quote.id !== token).flatMap((quote) =>
    FEE_TIERS.map((fee): PoolRef => ({ kind: "dcl", id: dclPoolId(token, quote.id, fee), tokens: [token, quote.id].sort() as [string, string] }))
  );
}

async function pricePool(token: string, tokenDecimals: number, pool: PoolRef, quote: QuotePrice): Promise<Priced | null> {
  const other = pool.tokens[0] === token ? pool.tokens[1] : pool.tokens[0];
  if (pool.kind === "dcl") {
    const live = await fetchDclPool(pool.id).catch(() => null);
    if (!live) return null;
    const tokenIsX = pool.tokens[0] === token;
    if ((tokenIsX ? live.totalY : live.totalX) === 0n) return null;
    const pricing = priceLaunch({ quote: other, tokenIsX }, live, quote.usd, quote.decimals, tokenDecimals);
    return pricing.priceUsd !== null && pricing.liquidityUsd !== null
      ? { pool, quote, priceUsd: pricing.priceUsd, liquidityUsd: pricing.liquidityUsd }
      : null;
  }
  const live = await fetchV2Reserves(pool.id).catch(() => null);
  if (!live) return null;
  const tokenAmount = live.amounts[live.tokens.indexOf(token)];
  const quoteAmount = live.amounts[live.tokens.indexOf(other)];
  if (!tokenAmount || !quoteAmount) return null;
  const quoteReserve = toUnits(quoteAmount, quote.decimals);
  const priceInQuote = quoteReserve / toUnits(tokenAmount, tokenDecimals);
  return { pool, quote, priceUsd: priceInQuote * quote.usd, liquidityUsd: 2 * quoteReserve * quote.usd };
}

/**
 * The token's deepest RHEA pool (classic or DCL) against any quote with a
 * known USD price, by USD liquidity.
 */
export async function bestPool(token: string, tokenDecimals: number, pricer: QuotePricer): Promise<Priced | null> {
  const seen = new Set<string>();
  const candidates = [...(await poolsForToken(token).catch(() => [])), ...guessedPools(token)]
    .filter((pool) => !seen.has(encodePool(pool)) && seen.add(encodePool(pool)));

  const withQuotes = (await Promise.all(candidates.map(async (pool) => {
    const other = pool.tokens[0] === token ? pool.tokens[1] : pool.tokens[0];
    const quote = await pricer(other).catch(() => null);
    return quote && quote.usd > 0 ? { pool, quote, preferred: PREFERRED.has(other) } : null;
  }))).filter((c): c is { pool: PoolRef; quote: QuotePrice; preferred: boolean } => c !== null);

  // Indexed pools and NEAR/LiNEAR pairs first; guessed ids that don't exist just fail.
  withQuotes.sort((a, b) => Number(b.preferred) - Number(a.preferred));
  const priced = await Promise.all(
    withQuotes.slice(0, MAX_POOLS_READ).map(({ pool, quote }) => pricePool(token, tokenDecimals, pool, quote))
  );
  return priced
    .filter((p): p is Priced => p !== null && Number.isFinite(p.priceUsd) && p.priceUsd > 0)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0] ?? null;
}

async function totalSupply(token: string): Promise<string | undefined> {
  const raw = await withRpcFallback((provider) =>
    provider.callFunction({ contractId: token, method: "ft_total_supply", args: {} })
  ).catch(() => undefined);
  return typeof raw === "string" && /^\d+$/.test(raw) ? raw : undefined;
}

/**
 * Live price, liquidity and market cap for any token with a RHEA pool
 * (classic or DCL) against a quote with a known USD price, read straight
 * from the chain. Used when every market-data API is unavailable; it has no
 * 24h stats. Null without a priceable pool.
 */
export async function onchainMarket(token: string, pricer: QuotePricer): Promise<NearMarket | null> {
  const meta = await ftMetadata(token).catch(() => null);
  if (!meta) return null;
  const [best, supply] = await Promise.all([bestPool(token, meta.decimals, pricer), totalSupply(token)]);
  if (!best) return null;
  const marketCapUsd = supply ? toUnits(BigInt(supply), meta.decimals) * best.priceUsd : null;
  return {
    address: token,
    name: (meta.name ?? meta.symbol).slice(0, 48),
    symbol: meta.symbol.slice(0, 24),
    dex: best.pool.kind === "dcl" ? "rhea DCL" : "rhea",
    pairLabel: `${meta.symbol.slice(0, 24)} / ${best.quote.symbol.slice(0, 24)}`,
    url: `https://dexscreener.com/near/${encodeURIComponent(token)}`,
    priceUsd: String(best.priceUsd),
    marketCapUsd,
    fdvUsd: marketCapUsd,
    liquidityUsd: best.liquidityUsd,
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
