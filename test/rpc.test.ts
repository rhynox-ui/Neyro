import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.NEAR_RPC_FALLBACK_URL ??= "https://rpc.mainnet.fastnear.com";

const { withRpcFallback } = await import("../src/near/rpc.js");

test("RPC failover uses the next endpoint after a failure", async () => {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => warnings.push(String(message));

  try {
    const result = await withRpcFallback(async (_provider, endpoint) => {
      if (endpoint.name === "primary") throw new Error("primary unavailable");
      return endpoint.name;
    });

    assert.equal(result, "fallback");
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = original;
  }
});
