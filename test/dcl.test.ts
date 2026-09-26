import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
const { dclPriceInQuote, parseDclPool } = await import("../src/market/dcl.js");
const { priceLaunch } = await import("../src/discovery/nearly.js");

const close = (a: number, b: number) => Math.abs(a - b) / b < 1e-9;
const SUPPLY = (1_000_000_000n * 10n ** 18n).toString();

test("a NEARly launch at point 0 has a 1,000 NEAR FDV (factory comment)", () => {
  // raw wNEAR per raw token = 1 → 1e-6 NEAR per token → 1e9 tokens = 1,000 NEAR
  assert.ok(close(dclPriceInQuote(0, true, 18, 24), 1e-6));
  const pool = { currentPoint: 0, totalX: 0n, totalY: 0n };
  const pricing = priceLaunch({ quote: "wrap.near", tokenIsX: true, totalSupply: SUPPLY }, pool, 3, 24);
  assert.ok(close(pricing.priceUsd!, 3e-6));
  assert.ok(close(pricing.marketCapUsd!, 3_000)); // 1,000 NEAR at $3
});

test("price direction follows which side of the pool the token is on", () => {
  // Token as Y at point -6932 is the same price as token as X at +6932 (≈2×).
  assert.ok(close(dclPriceInQuote(-6932, false, 18, 24), dclPriceInQuote(6932, true, 18, 24)));
  assert.ok(dclPriceInQuote(6932, true, 18, 24) > 1.99e-6 && dclPriceInQuote(6932, true, 18, 24) < 2.01e-6);
});

test("liquidity counts both reserves in USD", () => {
  const pool = { currentPoint: 0, totalX: 500_000_000n * 10n ** 18n, totalY: 200n * 10n ** 24n };
  const pricing = priceLaunch({ quote: "wrap.near", tokenIsX: true, totalSupply: SUPPLY }, pool, 3, 24);
  // 5e8 tokens × $3e-6 = $1,500 plus 200 NEAR × $3 = $600
  assert.ok(close(pricing.liquidityUsd!, 2_100));
  assert.deepEqual(priceLaunch({ quote: "wrap.near" }, pool, null, 24), { priceUsd: null, liquidityUsd: null, marketCapUsd: null });
});

test("parseDclPool reads ref-sdk PoolInfo fields", () => {
  assert.deepEqual(parseDclPool({ pool_id: "a|b|10000", current_point: -120, total_x: "5", total_y: "7" }), { currentPoint: -120, totalX: 5n, totalY: 7n });
  assert.equal(parseDclPool(null), null);
  assert.equal(parseDclPool({ current_point: "x" }), null);
});
