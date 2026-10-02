import { TOKEN_TOOL_FEES, type TokenToolFeeName } from "./fees";

/**
 * Web token-tool fees are collected by the same treasury account configured
 * for the existing Neyro bot. Keep this value explicit and separate from the
 * user's signing account and the token contract.
 *
 * Reference: the current bot deployment configuration uses
 * TREASURY_ACCOUNT_ID=widekingdom6862.near.
 */
export const TOKEN_TOOL_FEE_RECIPIENT = "widekingdom6862.near";

export type NativeTransferAction = {
  kind: "transfer";
  receiverId: string;
  amount: bigint;
};

export function buildTokenToolFeeTransfer(
  operation: TokenToolFeeName
): NativeTransferAction {
  return {
    kind: "transfer",
    receiverId: TOKEN_TOOL_FEE_RECIPIENT,
    amount: TOKEN_TOOL_FEES[operation].yoctoNear
  };
}
