import type { TradeSide } from "../domain/trading.js";
import type { SentTransaction } from "../wallet/near-account-signer.js";

export type BatchOutcome = "executed" | "reverted" | "partial" | "unknown" | "failed";

/**
 * Classifies what actually happened on chain for a transaction batch,
 * independently of whatever error the SDK raised.
 */
export function classifyBatch(sent: readonly SentTransaction[]): BatchOutcome {
  if (sent.length === 0 || sent.every((item) => item.result === "rejected")) return "failed";
  if (sent.some((item) => item.result === "unknown")) return "unknown";
  if (sent.some((item) => item.result === "reverted")) return "reverted";
  if (sent.every((item) => item.result === "executed")) return "executed";
  return "partial";
}

/**
 * The FT side of a NEAR-quoted trade: a buy receives the token and a sell
 * spends it. Balance deltas on this side don't include gas, so a zero delta
 * after an "executed" batch means the swap was refunded.
 */
export function assessFill(
  side: TradeSide,
  before: bigint,
  after: bigint,
  /** Fee paid in the same token as the FT side (sells), excluded from the fill. */
  feeOnFtSide = 0n
): { filled: boolean; amount: bigint } {
  const amount = side === "buy" ? after - before : before - after - feeOnFtSide;
  return { filled: amount > 0n, amount: amount > 0n ? amount : 0n };
}

/** RHEA quotes may carry expiresAt in seconds or milliseconds. */
export function quoteDeadline(
  now: number,
  maxTtlMs: number,
  expiresAt?: number
): number {
  const fallback = now + maxTtlMs;
  if (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= 0) return fallback;
  const ms = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  return Math.min(ms, fallback);
}

/** Normalize a router/API price-impact field into a decimal fraction.
 * Accepts 0.087, 8.7, or "8.7%".
 */
export function normalizePriceImpact(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim();
  const hasPercent = text.endsWith("%");
  const parsed = Number(text.replace(/%$/, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const fraction = hasPercent || parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, fraction);
}

/**
 * Fallback impact estimate when the router does not expose one.
 * This compares the quoted execution rate with the current reference
 * USD rate using the exact amount being swapped.
 */
export function estimatePriceImpact(
  amountIn: bigint,
  decimalsIn: number,
  priceIn: number | null,
  amountOut: bigint,
  decimalsOut: number,
  priceOut: number | null
): number | null {
  if (!priceIn || !priceOut || amountIn <= 0n || amountOut <= 0n) return null;
  const valueIn = (Number(amountIn) / 10 ** decimalsIn) * priceIn;
  const valueOut = (Number(amountOut) / 10 ** decimalsOut) * priceOut;
  if (!(valueIn > 0) || !Number.isFinite(valueIn) || !Number.isFinite(valueOut)) return null;
  return Math.max(0, Math.min(1, 1 - valueOut / valueIn));
}

/** Exact user-facing price-impact line for trade confirmation. */
export function priceImpactWarning(impact: number | null): string | undefined {
  if (impact === null || !Number.isFinite(impact)) return undefined;
  const pct = (impact * 100).toFixed(1);
  return impact >= 0.15
    ? `🚨 Very high price impact: ~${pct}%`
    : `price impact: ~${pct}%`;
}

/** "rhea · dcl (best of 3 routes)" from the SDK's route summary. */
export function describeRoute(route: { router?: string; market?: string } | undefined, alternatives = 0): string {
  const name = [route?.router, route?.market].filter(Boolean).join(" · ") || "RHEA";
  return alternatives > 0 ? `${name} (best of ${alternatives + 1} routes)` : name;
}
