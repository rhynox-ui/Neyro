import { describe, expect, it } from "vitest";
import { buildTransferBatches } from "../airdrop/batch-builder";
import {
  buildAirdropTransaction,
  buildNativeFeeTransfer,
  buildStorageRegistrationTransaction,
  MAX_STORAGE_REGISTRATION_ACTIONS,
  STORAGE_DEPOSIT_GAS
} from "./transaction-builder";

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


  it("builds bounded NEP-145 registration actions", () => {
    const request = buildStorageRegistrationTransaction(
      "payer.near",
      "token.near",
      ["alice.near", "bob.near"],
      2350000000000000000000n
    );

    expect(request.actions).toHaveLength(2);
    expect(request.actions[0]).toEqual({
      type: "FunctionCall",
      receiverId: "token.near",
      methodName: "storage_deposit",
      args: { account_id: "alice.near", registration_only: true },
      gas: STORAGE_DEPOSIT_GAS,
      deposit: 2350000000000000000000n
    });
  });

  it("caps registration transactions before the NEAR gas limit", () => {
    expect(() =>
      buildStorageRegistrationTransaction(
        "payer.near",
        "token.near",
        Array.from({ length: MAX_STORAGE_REGISTRATION_ACTIONS + 1 }, (_, i) => `user-${i}.near`),
        1n
      )
    ).toThrow("registration batch cannot exceed");
  });
