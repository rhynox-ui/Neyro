import { formatUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import type { WalletAction } from "../near/actions.js";


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
  contractId: "near";
  amount: string;
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
  // Keep the USD cap in fixed-point integers too. This avoids silently
  // rounding huge token-unit caps when a meme token has a very low price.
  const SCALE = 1_000_000_000n;
  const priceScaledNumber = Math.round(priceUsd * Number(SCALE));
  const capScaledNumber = Math.round(capUsd * Number(SCALE));
  if (
    !Number.isSafeInteger(priceScaledNumber) || priceScaledNumber <= 0 ||
    !Number.isSafeInteger(capScaledNumber) || capScaledNumber <= 0
  ) return null;
  const priceScaled = BigInt(priceScaledNumber);
  const capScaled = BigInt(capScaledNumber);
  const cap = (capScaled * 10n ** BigInt(decimals)) / priceScaled;
  return pctFee > cap ? { fee: cap, capped: true } : { fee: pctFee, capped: false };
}

/** Display the protocol fee in the asset actually collected: native NEAR. */
export function formatNativeFee(amountYoctoNear: string): string {
  return `${formatUnits(amountYoctoNear, 24)} NEAR`;
}

export function feeReceiver(plan: FeePlan): string {
  if (plan.contractId !== "near") throw new Error("Protocol fee asset must be native NEAR");
  return plan.treasury;
}

export function feeActions(plan: FeePlan): WalletAction[] {
  if (plan.contractId !== "near") throw new Error("Protocol fee asset must be native NEAR");
  const amount = BigInt(plan.amount);
  return [
    {
      type: "Transfer" as const,
      params: { deposit: amount.toString() }
    }
  ];
}


/** Convert a token-denominated fee to native NEAR without floating-point token arithmetic. */
export function tokenFeeToNative(
  tokenFee: bigint,
  tokenDecimals: number,
  tokenPriceUsd: number,
  nearPriceUsd: number
): bigint | null {
  if (tokenFee <= 0n || !Number.isFinite(tokenPriceUsd) || tokenPriceUsd <= 0 ||
      !Number.isFinite(nearPriceUsd) || nearPriceUsd <= 0) return null;
  const SCALE = 1_000_000_000n;
  const toScaled = (price: number): bigint | null => {
    const scaled = Math.round(price * Number(SCALE));
    return Number.isSafeInteger(scaled) && scaled > 0 ? BigInt(scaled) : null;
  };
  const tokenPrice = toScaled(tokenPriceUsd);
  const nearPrice = toScaled(nearPriceUsd);
  if (!tokenPrice || !nearPrice) return null;

  const denominator = 10n ** BigInt(tokenDecimals) * nearPrice;
  const numerator = tokenFee * tokenPrice * 10n ** 24n;
  return (numerator + denominator - 1n) / denominator;
}
