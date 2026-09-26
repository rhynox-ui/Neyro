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
  after: bigint
): { filled: boolean; amount: bigint } {
  const amount = side === "buy" ? after - before : before - after;
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
