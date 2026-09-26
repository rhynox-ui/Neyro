import { withRpcFallback } from "../near/rpc.js";

/** RHEA v2 Discretized Concentrated Liquidity contract (mainnet). */
export const DCL_CONTRACT = "dclv2.ref-labs.near";

export type DclPool = {
  currentPoint: number;
  /** Raw balances held by the pool, including limit orders. */
  totalX: bigint;
  totalY: bigint;
};

/** Parses dclv2 `get_pool` (PoolInfo in @ref-finance/ref-sdk). */
export function parseDclPool(raw: unknown): DclPool | null {
  if (!raw || typeof raw !== "object") return null;
  const { current_point, total_x, total_y } = raw as Record<string, unknown>;
  if (!Number.isInteger(current_point)) return null;
  const amount = (value: unknown) => (typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n);
  return { currentPoint: current_point as number, totalX: amount(total_x), totalY: amount(total_y) };
}

export async function fetchDclPool(poolId: string, contractId = DCL_CONTRACT): Promise<DclPool | null> {
  return withRpcFallback(async (provider) =>
    parseDclPool(await provider.callFunction({ contractId, method: "get_pool", args: { pool_id: poolId } }))
  );
}

/**
 * Whole quote tokens per whole token. A DCL point prices Y in X:
 * raw Y per raw X = 1.0001^point, so a token that is Y is priced at
 * 1.0001^-point raw X per raw token.
 */
export function dclPriceInQuote(point: number, tokenIsX: boolean, tokenDecimals: number, quoteDecimals: number): number {
  const raw = Math.pow(1.0001, tokenIsX ? point : -point);
  return raw * 10 ** (tokenDecimals - quoteDecimals);
}

export function toUnits(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}
