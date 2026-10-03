import { describe, expect, it } from "vitest";
import { NearRpcClient } from "./rpc";

describe("NEAR RPC client", () => {
  it("parses the current gas price as an exact bigint", async () => {
    const client = new NearRpcClient("https://rpc.example", async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { gas_price: "100000000" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(client.gasPrice()).resolves.toBe(100000000n);
  });

  it("rejects a malformed gas price", async () => {
    const client = new NearRpcClient("https://rpc.example", async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { gas_price: "not-a-number" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(client.gasPrice()).rejects.toThrow("invalid gas price");
  });
});

describe("NEAR RPC provider failover", () => {
  const ok = () => new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { gas_price: "7" } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

  it("uses the official free providers, not the deprecated near.org endpoint", () => {
    const client = new NearRpcClient();
    expect(client.urls).toEqual(["https://free.rpc.fastnear.com", "https://near.drpc.org"]);
  });

  it("fails over on rate limits and network errors", async () => {
    const seen: string[] = [];
    const client = new NearRpcClient(["https://a.test", "https://b.test", "https://c.test"], async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("a.test")) return new Response("", { status: 429 });
      if (url.includes("b.test")) throw new TypeError("Failed to fetch");
      return ok();
    });
    await expect(client.gasPrice()).resolves.toBe(7n);
    expect(seen).toEqual(["https://a.test", "https://b.test", "https://c.test"]);
  });

  it("does not fail over on a real RPC answer such as an unknown account", async () => {
    let calls = 0;
    const client = new NearRpcClient(["https://a.test", "https://b.test"], async () => {
      calls += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "UNKNOWN_ACCOUNT" } }), { status: 200 });
    });
    await expect(client.viewAccount("nobody.near")).rejects.toThrow("UNKNOWN_ACCOUNT");
    expect(calls).toBe(1);
  });

  it("calls the global fetch without an illegal receiver", async () => {
    const original = globalThis.fetch;
    let receiver: unknown = "unset";
    globalThis.fetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve(ok());
    } as typeof fetch;
    try {
      await new NearRpcClient("https://a.test").gasPrice();
      expect(receiver).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });
});
