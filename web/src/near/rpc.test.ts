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
