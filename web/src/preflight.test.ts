import { describe, expect, it, vi } from "vitest";
import { preflightSenders } from "./preflight";
import type { NearRpcClient } from "./near/rpc";

function rpcStub() {
  return {
    viewAccount: vi.fn(async (accountId: string) => ({
      amount: accountId === "a.near" ? "1000000000000000000000000" : "500000000000000000000000",
      locked: "0",
      storage_usage: 0,
      storage_paid_at: 0,
      block_height: 1,
      block_hash: "hash"
    })),
    viewFunction: vi.fn(async (contract: string, method: string, args: unknown) => {
      if (method === "ft_metadata") {
        return { spec: "ft-1.0.0", name: "Test", symbol: "TST", decimals: 6 };
      }
      if (method === "ft_balance_of") {
        return args && typeof args === "object" && "account_id" in args &&
          args.account_id === "a.near" ? "9000000" : "4000000";
      }
      if (method === "storage_balance_of") {
        const accountId = args && typeof args === "object" && "account_id" in args
          ? String(args.account_id)
          : "";
        if (accountId === "unregistered.near") return null;
        return { total: "125", available: "0" };
      }
      throw new Error("unexpected method");
    })
  } as unknown as NearRpcClient;
}

describe("sender preflight", () => {
  it("reads fresh native/token balances and registration state", async () => {
    const result = await preflightSenders(
      rpcStub(),
      "token.near",
      ["a.near", "b.near", "a.near"],
      12000000n,
      ["a.near", "unregistered.near", "a.near"]
    );

    expect(result.decimals).toBe(6);
    expect(result.senders).toHaveLength(2);
    expect(result.totalTokenBalance).toBe(13000000n);
    expect(result.enoughTokenBalance).toBe(true);
    expect(result.senders[0]).toMatchObject({
      senderId: "a.near",
      tokenBalance: 9000000n,
      storage: "registered"
    });
    expect(result.recipientRegistration).toEqual({
      checked: 2,
      registered: 1,
      notRegistered: 1,
      unsupported: 0,
      sampleNotRegistered: ["unregistered.near"]
    });
  });
});
