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

/**
 * Share of the trade's USD value lost between what goes in and what the
 * quote says comes out: pool fees (up to 19.99% on a permissionless RHEA
 * Classic pool) plus price impact. Null when either side has no USD price.
 * Negative values (a quote better than the reference price) are clamped to 0.
 */
export function estimateValueLoss(
  amountIn: bigint,
  decimalsIn: number,
  priceIn: number | null,
  amountOut: bigint,
  decimalsOut: number,
  priceOut: number | null
): number | null {
  if (!priceIn || !priceOut || amountIn <= 0n) return null;
  const valueIn = (Number(amountIn) / 10 ** decimalsIn) * priceIn;
  const valueOut = (Number(amountOut) / 10 ** decimalsOut) * priceOut;
  if (!(valueIn > 0) || !Number.isFinite(valueOut)) return null;
  return Math.max(0, 1 - valueOut / valueIn);
}

/** Warning line for the confirm screen, or undefined when the loss is normal. */
export function valueLossWarning(loss: number | null): string | undefined {
  if (loss === null || loss < 0.03) return undefined;
  const pct = (loss * 100).toFixed(1);
  return loss >= 0.15
    ? `🚨 You lose about ${pct}% of the trade's value to pool fees and price impact. This pool may charge a very high fee or have very little liquidity.`
    : `⚠️ About ${pct}% of the trade's value goes to pool fees and price impact.`;
}
