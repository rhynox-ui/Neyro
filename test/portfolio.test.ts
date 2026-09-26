import test from "node:test";
import assert from "node:assert/strict";
import { formatUnits } from "@rhea-finance/cross-chain-aggregation-dex";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { parseFtBalance } = await import("../src/near/ft.js");

test("portfolio amount formatting uses token decimals", () => {
  assert.equal(formatUnits("1234500", 6), "1.2345");
  assert.equal(formatUnits("1000000000000000000000000", 24), "1");
});

test("ft_balance_of accepts decoded U128 strings", () => {
  assert.equal(parseFtBalance("1000000000000000000000000"), "1000000000000000000000000");
  assert.equal(parseFtBalance("0"), "0");
});

test("ft_balance_of rejects non-string or malformed results", () => {
  assert.throws(() => parseFtBalance(123));
  assert.throws(() => parseFtBalance(undefined));
  assert.throws(() => parseFtBalance("-1"));
  assert.throws(() => parseFtBalance("1.5"));
});
