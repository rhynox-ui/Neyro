import { functionCall, type WalletAction } from "../near/actions.js";

const STORAGE_DEPOSIT_GAS = 10_000_000_000_000n;
const FT_TRANSFER_GAS = 15_000_000_000_000n;
export const WRAPPED_NEAR = "wrap.near";
export const NATIVE_NEAR = "near";

/**
 * How the protocol fee is collected for one trade. Serializable: it is
 * stored with the pending quote.
 *
 * - buy: `amount` yoctoNEAR is sent to the treasury as native NEAR
 * - sell: `amount` yoctoNEAR of native NEAR is sent to the treasury
 */
export type FeePlan = {
  side: "buy" | "sell";
  treasury: string;
  /** Native NEAR is always used for protocol fees. */
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
    {
      type: "Transfer" as const,
      params: { deposit: amount.toString() }
    }
  ];
}
