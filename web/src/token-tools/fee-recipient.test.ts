import { describe, expect, it } from "vitest";
import {
  TOKEN_TOOL_FEE_RECIPIENT,
  buildTokenToolFeeTransfer
} from "./fee-recipient";

describe("token tool fee recipient", () => {
  it("uses the Neyro bot treasury for mint fees", () => {
    const action = buildTokenToolFeeTransfer("mint");
    expect(action.receiverId).toBe(TOKEN_TOOL_FEE_RECIPIENT);
    expect(action.amount).toBe(1_000_000_000_000_000_000_000_000n);
  });

  it("uses the same treasury for lock fees", () => {
    const action = buildTokenToolFeeTransfer("lock");
    expect(action.receiverId).toBe(TOKEN_TOOL_FEE_RECIPIENT);
    expect(action.amount).toBe(1_000_000_000_000_000_000_000_000n);
  });
});
