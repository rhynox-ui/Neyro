import type { Account } from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { createNearConnection } from "./client.js";
import { withRpcFallback } from "./rpc.js";

/** Storage staking cost: 1 NEAR per 100 kB = 10^19 yoctoNEAR per byte. */
const STORAGE_PRICE_PER_BYTE = 10n ** 19n;

/** Kept back from trades to pay gas and FT storage registration. */
export const GAS_RESERVE_YOCTO = 5n * 10n ** 22n; // 0.05 NEAR

export type NearBalance = {
  /** false for an implicit account that has never been funded. */
  exists: boolean;
  total: bigint;
  storage: bigint;
  /** Liquid NEAR not held for storage staking. */
  available: bigint;
};

export function nearBalanceFromView(view: {
  amount: bigint;
  locked: bigint;
  storage_usage: number;
}): NearBalance {
  const storage = BigInt(view.storage_usage) * STORAGE_PRICE_PER_BYTE;
  // Staked (locked) NEAR also counts toward storage staking.
  const heldForStorage = storage > view.locked ? storage - view.locked : 0n;
  const available = view.amount > heldForStorage ? view.amount - heldForStorage : 0n;
  return { exists: true, total: view.amount, storage, available };
}

/** Spendable for a trade after keeping the gas reserve. */
export function tradableNear(balance: NearBalance): bigint {
  return balance.available > GAS_RESERVE_YOCTO ? balance.available - GAS_RESERVE_YOCTO : 0n;
}

export function getNearAccount(accountId: string): Account {
  return createNearConnection().account(accountId);
}

export async function getNearBalance(accountId: string): Promise<NearBalance> {
  try {
    return await withRpcFallback(async (provider) =>
      nearBalanceFromView(await provider.viewAccount({ accountId }))
    );
  } catch (error) {
    if (error instanceof AccountDoesNotExistError) {
      return { exists: false, total: 0n, storage: 0n, available: 0n };
    }
    throw error;
  }
}

export async function accountExists(accountId: string): Promise<boolean> {
  return (await getNearBalance(accountId)).exists;
}
