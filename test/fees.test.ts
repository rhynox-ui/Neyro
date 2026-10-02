import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { formatCreatorFee } = await import("../src/launch/fees.js");

test("formats NEARly creator token fees using 18 decimals", () => {
  assert.equal(
    formatCreatorFee({ amount: "1000000000000000000", decimals: 18 }),
    "1"
  );
});

test("formats pair creator fees using the pair's decimals", () => {
  assert.equal(
    formatCreatorFee({ amount: "123456", decimals: 6 }),
    "0.123456"
  );
});
