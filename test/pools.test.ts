import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
const { parseV2Pools, parseDclPools, encodePool, decodePool } = await import("../src/market/pools.js");
const { buildQuotePricer } = await import("../src/market/onchain.js");

test("v2 index keeps only two-token simple pools, numbered from the page start", () => {
  const pools = parseV2Pools([
    { pool_kind: "SIMPLE_POOL", token_account_ids: ["umbra.umbrafun.near", "linear-protocol.near"] },
    { pool_kind: "STABLE_SWAP", token_account_ids: ["a.near", "b.near", "c.near"] },
    { pool_kind: "SIMPLE_POOL", token_account_ids: ["x.near", "wrap.near"] }
  ], 500);
  assert.deepEqual(pools.map((p) => p.id), [500, 502]);
  assert.deepEqual(pools[0]!.tokens, ["umbra.umbrafun.near", "linear-protocol.near"]);
});

test("DCL index uses pool_id, or builds it from tokens and fee", () => {
  const pools = parseDclPools([
    { pool_id: "linear-protocol.near|umbra.umbrafun.near|2000", token_x: "linear-protocol.near", token_y: "umbra.umbrafun.near", fee: 2000 },
    { token_x: "a.near", token_y: "wrap.near", fee: 10000 }
  ]);
  assert.deepEqual(pools.map((p) => p.id), ["linear-protocol.near|umbra.umbrafun.near|2000", "a.near|wrap.near|10000"]);
});

test("compact pool refs round-trip", () => {
  for (const pool of [
    { kind: "v2", id: 42, tokens: ["a.near", "wrap.near"] },
    { kind: "dcl", id: "a.near|wrap.near|100", tokens: ["a.near", "wrap.near"] }
  ] as const) {
    assert.deepEqual(decodePool(encodePool(pool)), pool);
  }
  assert.equal(decodePool("junk"), null);
});

test("quote pricer covers NEAR and any listed token with a price", async () => {
  const pricer = buildQuotePricer([
    { address: "nep141:usdt.tether-token.near", decimals: 6, symbol: "USDT", price: "1.0" },
    { address: "nep141:nopriced.near", decimals: 18, symbol: "NP" }
  ], 3);
  assert.deepEqual(await pricer("wrap.near"), { usd: 3, decimals: 24, symbol: "NEAR" });
  assert.deepEqual(await pricer("usdt.tether-token.near"), { usd: 1, decimals: 6, symbol: "USDT" });
  assert.equal(await pricer("nopriced.near"), null);
});
