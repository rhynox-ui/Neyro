import { describe, expect, it } from "vitest";
import {
  TOKEN_TOOL_FEES,
  YOCTONEAR_PER_NEAR,
  formatTokenToolFee,
  getTokenToolFee,
  getAirdropFee,
  formatNearAmount
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

  it("charges 0.1 NEAR for burn", () => {
    expect(getTokenToolFee("burn")).toBe(YOCTONEAR_PER_NEAR / 10n);
  });

  it("prices airdrops at 0.01 NEAR per recipient between 1 and 250 NEAR", () => {
    expect(formatNearAmount(getAirdropFee(5))).toBe("1 NEAR");
    expect(formatNearAmount(getAirdropFee(100))).toBe("1 NEAR");
    expect(formatNearAmount(getAirdropFee(1234))).toBe("12.34 NEAR");
    expect(formatNearAmount(getAirdropFee(1_000_000))).toBe("250 NEAR");
    expect(() => getAirdropFee(0)).toThrow();
  });
});
