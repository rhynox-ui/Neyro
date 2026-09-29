import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "https://example.com/test-db";
process.env.NEAR_RPC_URL = "https://rpc.primary.example";
process.env.NEAR_RPC_FALLBACK_URL = "https://rpc.fallback.example";

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

test("FastNEAR key is sent only to FastNEAR hosts", async () => {
  const { fastnearHeaders, config } = await import("../src/config.js");
  (config as { FASTNEAR_API_KEY?: string }).FASTNEAR_API_KEY = "k";
  assert.deepEqual(fastnearHeaders("https://rpc.mainnet.fastnear.com"), { Authorization: "Bearer k" });
  assert.deepEqual(fastnearHeaders("https://api.fastnear.com/v1/x"), { Authorization: "Bearer k" });
  assert.deepEqual(fastnearHeaders("https://rpc.mainnet.near.org"), {});
  assert.deepEqual(fastnearHeaders("https://evil-fastnear.com"), {});
  (config as { FASTNEAR_API_KEY?: string }).FASTNEAR_API_KEY = undefined;
  assert.deepEqual(fastnearHeaders("https://rpc.mainnet.fastnear.com"), {});
});
