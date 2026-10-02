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
  }
} as const;

export type TokenToolFeeName = keyof typeof TOKEN_TOOL_FEES;

export function getTokenToolFee(name: TokenToolFeeName): bigint {
  return TOKEN_TOOL_FEES[name].yoctoNear;
}

export function formatTokenToolFee(name: TokenToolFeeName): string {
  return `${TOKEN_TOOL_FEES[name].near} NEAR`;
}
