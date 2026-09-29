import { UserFacingError } from "../errors.js";

export type RiskPolicy = {
  maxSlippageBps: number;
};

export const DEFAULT_RISK_POLICY: RiskPolicy = {
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
