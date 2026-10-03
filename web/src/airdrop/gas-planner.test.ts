import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREPAID_GAS,
  DEFAULT_RESERVED_GAS,
  MAX_ACTIONS_PER_RECEIPT,
  MAX_TOTAL_PREPAID_GAS,
  maxSafeActions,
  planBatchGas
} from "./gas-planner";

describe("airdrop gas planner", () => {
  it("keeps the 300 Tgas protocol ceiling separate from the action ceiling", () => {
    expect(MAX_TOTAL_PREPAID_GAS).toBe(300_000_000_000_000n);
    expect(MAX_ACTIONS_PER_RECEIPT).toBe(100);
  });

  it("limits default 30 Tgas transfers to eight actions", () => {
    expect(maxSafeActions()).toBe(8);
  });

  it("leaves a conservative gas reserve", () => {
    const plan = planBatchGas(8);
    expect(plan.totalPrepaidGas).toBe(240_000_000_000_000n);
    expect(plan.reservedGas).toBe(DEFAULT_RESERVED_GAS);
    expect(plan.totalPrepaidGas + plan.reservedGas).toBe(MAX_TOTAL_PREPAID_GAS);
  });

  it("rejects a batch that would exceed the gas budget", () => {
    expect(() => planBatchGas(9)).toThrow("only 8 fit");
  });

  it("supports lower per-action gas without exceeding the 100-action ceiling", () => {
    expect(maxSafeActions(2_000_000_000_000n, 10_000_000_000_000n)).toBe(100);
  });

  it("rejects invalid gas configuration", () => {
    expect(() => maxSafeActions(0n)).toThrow();
    expect(() => maxSafeActions(DEFAULT_PREPAID_GAS, MAX_TOTAL_PREPAID_GAS)).toThrow();
  });
});
