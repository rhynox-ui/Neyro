import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ACTIONS,
  DEFAULT_PREPAID_GAS,
  YOCTONEAR,
  buildFtTransferAction,
  buildTransferBatches
} from "./batch-builder";

describe("NEP-141 batch builder", () => {
  it("builds ft_transfer with 1 yoctoNEAR and explicit gas", () => {
    const action = buildFtTransferAction("alice.near", 123n);
    expect(action.methodName).toBe("ft_transfer");
    expect(action.args).toEqual({
      receiverId: "alice.near",
      amount: "123"
    });
    expect(action.deposit).toBe(YOCTONEAR);
    expect(action.gas).toBe(DEFAULT_PREPAID_GAS);
  });

  it("uses a gas-safe default instead of the 100-action protocol ceiling", () => {
    expect(DEFAULT_MAX_ACTIONS).toBe(8);
  });

  it("splits recipients deterministically within the gas-safe limit", () => {
    const batches = buildTransferBatches(
      "sender.near",
      Array.from({ length: 17 }, (_, i) => ({
        wallet: `user${i}.near`,
        amountBase: BigInt(i + 1)
      }))
    );

    expect(batches.map((batch) => batch.actions.length)).toEqual([8, 8, 1]);
    expect(batches[0].batchId).toBe("sender.near:0");
    expect(batches[2].totalAmount).toBe(17n);
    expect(batches[0].totalPrepaidGas).toBe(240_000_000_000_000n);
  });

  it("rejects a requested batch size that exceeds the conservative gas budget", () => {
    expect(() =>
      buildTransferBatches(
        "sender.near",
        [{ wallet: "alice.near", amountBase: 1n }],
        9
      )
    ).toThrow("exceeds conservative gas-safe limit");
  });

  it("rejects invalid action inputs", () => {
    expect(() => buildFtTransferAction("", 1n)).toThrow();
    expect(() => buildFtTransferAction("alice.near", 0n)).toThrow();
    expect(() => buildTransferBatches("sender.near", [], 0)).toThrow();
  });
});
