import { describe, expect, it } from "vitest";
import {
  TOKEN_TOOL_FEES,
  YOCTONEAR_PER_NEAR,
  formatTokenToolFee,
  getTokenToolFee
} from "./fees";

describe("token tool native NEAR fees", () => {
  it("charges exactly 1 NEAR for mint", () => {
    expect(getTokenToolFee("mint")).toBe(YOCTONEAR_PER_NEAR);
    expect(TOKEN_TOOL_FEES.mint.near).toBe("1");
    expect(formatTokenToolFee("mint")).toBe("1 NEAR");
  });

  it("charges exactly 1 NEAR for lock", () => {
    expect(getTokenToolFee("lock")).toBe(YOCTONEAR_PER_NEAR);
    expect(TOKEN_TOOL_FEES.lock.near).toBe("1");
    expect(formatTokenToolFee("lock")).toBe("1 NEAR");
  });
});
