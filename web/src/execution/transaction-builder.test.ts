import { describe, expect, it } from "vitest";
import { buildTransferBatches } from "../airdrop/batch-builder";
import { buildAirdropTransaction, buildNativeFeeTransfer } from "./transaction-builder";

describe("web transaction builder", () => {
  const batch = buildTransferBatches("sender.near", [
    { wallet: "alice.near", amountBase: 123n }
  ])[0];

  it("converts a planned FT batch into wallet actions without signing", () => {
    const request = buildAirdropTransaction("sender.near", "token.near", batch);

    expect(request.signerId).toBe("sender.near");
    expect(request.receiverId).toBe("token.near");
    expect(request.actions).toEqual([{
      type: "FunctionCall",
      receiverId: "token.near",
      methodName: "ft_transfer",
      args: { receiverId: "alice.near", amount: "123" },
      gas: 30_000_000_000_000n,
      deposit: 1n
    }]);
  });

  it("rejects a batch assigned to a different sender", () => {
    expect(() =>
      buildAirdropTransaction("other.near", "token.near", batch)
    ).toThrow("batch sender does not match signer");
  });

  it("builds a native NEAR product-fee transfer separately", () => {
    const request = buildNativeFeeTransfer(
      "user.near",
      "widekingdom6862.near",
      1_000_000_000_000_000_000_000_000n
    );

    expect(request).toEqual({
      signerId: "user.near",
      receiverId: "widekingdom6862.near",
      actions: [{
        type: "Transfer",
        receiverId: "widekingdom6862.near",
        deposit: 1_000_000_000_000_000_000_000_000n
      }]
    });
  });

  it("rejects zero product fees", () => {
    expect(() => buildNativeFeeTransfer("user.near", "treasury.near", 0n)).toThrow();
  });
});
