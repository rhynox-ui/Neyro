import { describe, expect, it, vi } from "vitest";
import { getFtBalance, getFtMetadata, getStorageBalance, getStorageBalanceBounds, getStorageRegistrationState, isRegistered } from "./ft";
import { NearRpcClient } from "./rpc";

function clientWith<T>(value: T) {
  return new NearRpcClient("https://example.test", vi.fn(async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          result: Array.from(new TextEncoder().encode(JSON.stringify(value))),
          logs: [],
          block_height: 1,
          block_hash: "hash"
        }
      })
    )
  ));
}

describe("NEP-141 read helpers", () => {
  it("reads and validates metadata", async () => {
    const rpc = clientWith({
      spec: "ft-1.0.0",
      name: "Example",
      symbol: "EX",
      decimals: 24
    });
    await expect(getFtMetadata(rpc, "token.near")).resolves.toMatchObject({
      symbol: "EX",
      decimals: 24
    });
  });

  it("reads an exact bigint token balance", async () => {
    const rpc = clientWith("123456789012345678901234");
    await expect(getFtBalance(rpc, "token.near", "alice.near")).resolves.toBe(
      123456789012345678901234n
    );
  });

  it("distinguishes registered storage from zero storage", () => {
    expect(isRegistered({ total: "1250000000000000000000" })).toBe(true);
    expect(isRegistered({ total: "0" })).toBe(false);
    expect(isRegistered(null)).toBe(false);
  });

  it("returns storage registration state", async () => {
    const rpc = clientWith({ total: "125", available: "0" });
    await expect(
      getStorageBalance(rpc, "token.near", "alice.near")
    ).resolves.toEqual({ total: "125", available: "0" });
    await expect(
      getStorageRegistrationState(rpc, "token.near", "alice.near")
    ).resolves.toBe("registered");
  });
  it("reads and validates storage balance bounds", async () => {
    const rpc = clientWith({ min: "2350000000000000000000", max: "2350000000000000000000" });
    await expect(getStorageBalanceBounds(rpc, "token.near")).resolves.toEqual({
      min: "2350000000000000000000",
      max: "2350000000000000000000"
    });
  });
});
