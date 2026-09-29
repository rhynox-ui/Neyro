import { UserFacingError } from "../errors.js";

export type RiskPolicy = {
  maxSlippageBps: number;
  maxTradeBpsOfBalance: number;
};

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  // 15% covers thin meme pools; the token panel offers 5/10/15% presets.
  maxSlippageBps: 1_500,
  maxTradeBpsOfBalance: 2_500
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
  amount: bigint,
  balance: bigint,
  maxTradeBpsOfBalance: number
): void {
  if (balance <= 0n || amount <= 0n) {
    throw new UserFacingError("Trade amount must be positive");
  }
  if (!Number.isInteger(maxTradeBpsOfBalance) || maxTradeBpsOfBalance < 1 || maxTradeBpsOfBalance > 10_000) {
    throw new UserFacingError("Invalid trade-size risk policy");
  }
  if (amount * 10_000n > balance * BigInt(maxTradeBpsOfBalance)) {
    throw new UserFacingError(
      `Trade size exceeds Neyro's maximum of ${maxTradeBpsOfBalance / 100}% of the available balance`
    );
  }
}
