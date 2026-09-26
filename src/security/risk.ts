import { UserFacingError } from "../errors.js";

export type RiskPolicy = {
  maxTradeBpsOfBalance: number;
  maxSlippageBps: number;
};

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  maxTradeBpsOfBalance: 2_500,
  // 15% covers thin meme pools; the token panel offers 5/10/15% presets.
  maxSlippageBps: 1_500
};

export function assertSlippageAllowed(
  slippageBps: number,
  policy = DEFAULT_RISK_POLICY
): void {
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new UserFacingError("Slippage must be a non-negative integer in basis points");
  }

  if (slippageBps > policy.maxSlippageBps) {
    throw new UserFacingError(
      `Slippage exceeds Neyro's maximum of ${policy.maxSlippageBps / 100}%`
    );
  }
}

export function assertTradeShareAllowed(
  amountBpsOfBalance: number,
  policy = DEFAULT_RISK_POLICY
): void {
  if (!Number.isFinite(amountBpsOfBalance) || amountBpsOfBalance < 0) {
    throw new UserFacingError("Invalid trade balance share");
  }

  if (amountBpsOfBalance > policy.maxTradeBpsOfBalance) {
    throw new UserFacingError("Trade exceeds the configured wallet risk limit");
  }
}
