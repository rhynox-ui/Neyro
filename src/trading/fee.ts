import { functionCall, type WalletAction } from "../near/actions.js";
import type { PlannedTransaction } from "../wallet/near-account-signer.js";

const MAX_TX_GAS = 300_000_000_000_000n;
const STORAGE_DEPOSIT_GAS = 10_000_000_000_000n;
const NEAR_DEPOSIT_GAS = 10_000_000_000_000n;
const FT_TRANSFER_GAS = 15_000_000_000_000n;
export const WRAPPED_NEAR = "wrap.near";

/**
 * How the protocol fee is collected for one trade. Serializable: it is
 * stored with the pending quote.
 *
 * - buy: `amount` yoctoNEAR is wrapped and sent to the treasury as wNEAR
 * - sell: `amount` of the token being sold is sent to the treasury
 */
export type FeePlan = {
  side: "buy" | "sell";
  treasury: string;
  /** FT contract the fee is paid in: wrap.near for buys, the token for sells. */
  contractId: string;
  amount: string;
  /** yoctoNEAR storage deposit to register the treasury on contractId, if needed. */
  registerTreasury?: string;
  capped: boolean;
};

/**
 * `bps` of `amount`, capped at `capUsd` worth of the asset. Returns null
 * when the asset has no USD price, since the cap can't be enforced then.
 */
export function computeFee(
  amount: bigint,
  decimals: number,
  priceUsd: number | null,
  bps: number,
  capUsd: number
): { fee: bigint; capped: boolean } | null {
  if (bps <= 0 || amount <= 0n) return { fee: 0n, capped: false };
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const pctFee = (amount * BigInt(bps)) / 10_000n;
  // Cap in base units: (capUsd / price) tokens, with 9 decimal places of
  // precision, then scaled to the token's decimals.
  const capUnitsScaled = BigInt(Math.floor((capUsd / priceUsd) * 1e9));
  const cap = (capUnitsScaled * 10n ** BigInt(decimals)) / 1_000_000_000n;
  return pctFee > cap ? { fee: cap, capped: true } : { fee: pctFee, capped: false };
}

export function feeActions(plan: FeePlan): WalletAction[] {
  const amount = BigInt(plan.amount);
  return [
    ...(plan.registerTreasury
      ? [functionCall("storage_deposit", { account_id: plan.treasury, registration_only: true }, STORAGE_DEPOSIT_GAS, BigInt(plan.registerTreasury))]
      : []),
    ...(plan.side === "buy" ? [functionCall("near_deposit", {}, NEAR_DEPOSIT_GAS, amount)] : []),
    functionCall("ft_transfer", { receiver_id: plan.treasury, amount: plan.amount, memo: "neyro fee" }, FT_TRANSFER_GAS, 1n)
  ];
}

function gasOf(actions: readonly WalletAction[]): bigint {
  return actions.reduce((sum, action) => sum + (action.type === "FunctionCall" ? BigInt(action.params.gas) : 0n), 0n);
}

const SWAP_METHODS = new Set(["ft_transfer_call", "near_deposit"]);

/**
 * Adds the fee to the swap's own transaction so the trade stays a single
 * transaction: the swap transaction for both sides is addressed to the
 * contract the fee is paid in (wrap.near for NEAR in, the token for a
 * sell). If no such transaction exists, or it has no gas headroom, the fee
 * becomes its own transaction at the end of the batch. That is only sent
 * if everything before it executed.
 */
export function injectFee(
  transactions: PlannedTransaction[],
  plan: FeePlan
): { transactions: PlannedTransaction[]; mode: "same-transaction" | "separate-transaction" | "none" } {
  if (BigInt(plan.amount) === 0n) return { transactions, mode: "none" };
  const extra = feeActions(plan);

  const index = transactions.findIndex((tx) =>
    tx.receiverId === plan.contractId &&
    tx.actions.some((action) => action.type === "FunctionCall" && SWAP_METHODS.has(action.params.methodName))
  );
  const target = transactions[index];
  if (target && gasOf(target.actions) + gasOf(extra) <= MAX_TX_GAS) {
    const next = [...transactions];
    // After RHEA's actions: those may register the user on the contract
    // (storage_deposit) that the fee's near_deposit/ft_transfer rely on.
    next[index] = { receiverId: target.receiverId, actions: [...target.actions, ...extra] };
    return { transactions: next, mode: "same-transaction" };
  }

  return {
    transactions: [...transactions, { receiverId: plan.contractId, actions: extra }],
    mode: "separate-transaction"
  };
}
