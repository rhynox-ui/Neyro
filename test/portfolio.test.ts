import test from "node:test";
import assert from "node:assert/strict";
import { formatUnits } from "@rhea-finance/cross-chain-aggregation-dex";

test("portfolio amount formatting uses token decimals", () => {
  assert.equal(formatUnits("1234500", 6), "1.2345");
  assert.equal(formatUnits("1000000000000000000000000", 24), "1");
});
