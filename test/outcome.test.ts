import test from "node:test";
import assert from "node:assert/strict";

import {
  estimatePriceImpact,
  normalizePriceImpact,
  priceImpactWarning
} from "../src/trading/outcome.js";

test("normalizes router price impact values", () => {
  assert.equal(normalizePriceImpact(0.087), 0.087);
  assert.equal(normalizePriceImpact(8.7), 0.087);
  assert.equal(normalizePriceImpact("8.7%"), 0.087);
  assert.equal(normalizePriceImpact("0.087"), 0.087);
});

test("price impact uses quoted execution value versus reference value", () => {
  // $100 in, $91.3 out at the reference rate => 8.7% impact.
  assert.ok(Math.abs(estimatePriceImpact(100n, 0, 1, 913n, 1, 1)! - 0.087) < 1e-12);
});

test("price-impact confirmation text follows the requested thresholds", () => {
  assert.equal(priceImpactWarning(0.087), "price impact: ~8.7%");
  assert.equal(priceImpactWarning(0.149), "price impact: ~14.9%");
  assert.equal(priceImpactWarning(0.15), "🚨 Very high price impact: ~15.0%");
  assert.equal(priceImpactWarning(0.214), "🚨 Very high price impact: ~21.4%");
  assert.equal(priceImpactWarning(null), undefined);
});
