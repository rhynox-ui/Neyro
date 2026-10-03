export const YOCTONEAR_PER_NEAR = 1_000_000_000_000_000_000_000_000n;

export const TOKEN_TOOL_FEES = {
  mint: {
    label: "Mint",
    near: "1",
    yoctoNear: YOCTONEAR_PER_NEAR
  },
  lock: {
    label: "Lock",
    near: "1",
    yoctoNear: YOCTONEAR_PER_NEAR
  },
  burn: {
    label: "Burn",
    near: "0.1",
    yoctoNear: YOCTONEAR_PER_NEAR / 10n
  }
} as const;

/**
 * Airdrop pricing: a per-recipient fee with a floor and a ceiling, charged
 * once per campaign. Benchmarked against no-code multisenders (Smithii
 * 0.001 SOL/wallet, Jumpbit 0.002-0.003 SOL/wallet, EVM tools ~$0.3-1/wallet).
 */
export const AIRDROP_FEE = {
  perRecipient: YOCTONEAR_PER_NEAR / 100n, // 0.01 NEAR
  minimum: YOCTONEAR_PER_NEAR, // 1 NEAR
  maximum: 250n * YOCTONEAR_PER_NEAR // 250 NEAR
} as const;

export function getAirdropFee(recipientCount: number): bigint {
  if (!Number.isSafeInteger(recipientCount) || recipientCount <= 0) {
    throw new Error("Airdrop fee requires a positive recipient count");
  }
  const raw = AIRDROP_FEE.perRecipient * BigInt(recipientCount);
  if (raw < AIRDROP_FEE.minimum) return AIRDROP_FEE.minimum;
  if (raw > AIRDROP_FEE.maximum) return AIRDROP_FEE.maximum;
  return raw;
}

export function formatNearAmount(yocto: bigint): string {
  const whole = yocto / YOCTONEAR_PER_NEAR;
  const fraction = (yocto % YOCTONEAR_PER_NEAR).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} NEAR`;
}

export type TokenToolFeeName = keyof typeof TOKEN_TOOL_FEES;

export function getTokenToolFee(name: TokenToolFeeName): bigint {
  return TOKEN_TOOL_FEES[name].yoctoNear;
}

export function formatTokenToolFee(name: TokenToolFeeName): string {
  return `${TOKEN_TOOL_FEES[name].near} NEAR`;
}
