import { describe, expect, it } from "vitest";
import {
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

  it("splits recipients deterministically", () => {
    const batches = buildTransferBatches(
      "sender.near",
      Array.from({ length: 101 }, (_, i) => ({
        wallet: `user${i}.near`,
        amountBase: BigInt(i + 1)
      })),
      50
    );

    expect(batches.map((batch) => batch.actions.length)).toEqual([50, 50, 1]);
    expect(batches[0].batchId).toBe("sender.near:0");
    expect(batches[2].totalAmount).toBe(101n);
  });

  it("rejects invalid action inputs", () => {
    expect(() => buildFtTransferAction("", 1n)).toThrow();
    expect(() => buildFtTransferAction("alice.near", 0n)).toThrow();
    expect(() => buildTransferBatches("sender.near", [], 0)).toThrow();
  });
});
