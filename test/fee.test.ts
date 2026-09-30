import test from "node:test";
import assert from "node:assert/strict";
import { computeFee, feeActions, feeReceiver, tokenFeeToNative, type FeePlan } from "../src/trading/fee.js";
import { assessFill } from "../src/trading/outcome.js";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
const { feeLabel } = await import("../src/bot/panel.js");

const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;

test("fee is 1% below the cap", () => {
  // 100 NEAR at $3 = $300 → 1% = 1 NEAR ($3), well under $60.
  assert.deepEqual(computeFee(100n * NEAR, 24, 3, 100, 60), { fee: 1n * NEAR, capped: false });
});

test("fee is capped at $60 worth of the asset", () => {
  // 10,000 NEAR at $3 = $30,000 → 1% = $300 → capped to $60 = 20 NEAR.
  assert.deepEqual(computeFee(10_000n * NEAR, 24, 3, 100, 60), { fee: 20n * NEAR, capped: true });
  // Token with 6 decimals at $0.0005: $60 = 120,000 tokens.
  assert.deepEqual(computeFee(1_000_000_000n * 10n ** 6n, 6, 0.0005, 100, 60), { fee: 120_000n * 10n ** 6n, capped: true });
});

test("no USD price means the cap can't be enforced, so no fee is planned", () => {
  assert.equal(computeFee(100n * NEAR, 24, null, 100, 60), null);
  assert.deepEqual(computeFee(100n * NEAR, 24, null, 0, 60), { fee: 0n, capped: false });
});

const buyPlan: FeePlan = { side: "buy", treasury: "fees.neyro.near", contractId: "near", amount: "1000", capped: false };
test("sell fee conversion stays exact for large token base-unit amounts", () => {
  const tokenFee = 120_000n * 10n ** 6n; // $60 at $0.0005/token
  assert.equal(
    tokenFeeToNative(tokenFee, 6, 0.0005, 3),
    20n * NEAR
  );

  // The input is intentionally larger than Number.MAX_SAFE_INTEGER.
  const hugeFee = 9_000_000_000_000_000_001n;
  const converted = tokenFeeToNative(hugeFee, 18, 0.123456789, 3.21);
  assert.ok(converted !== null && converted > 0n);
});

test("fee cap stays accurate for very low-priced high-supply tokens", () => {
  const result = computeFee(1_000_000_000_000_000_000_000_000n, 18, 0.000000001, 100, 60);
  assert.deepEqual(result, { fee: 60_000_000_000n * 10n ** 18n, capped: true });
});

test("protocol fees are always native NEAR transfers", () => {
  const buy = feeActions(buyPlan)[0]!;
  assert.equal(buy.type, "Transfer");
  if (buy.type === "Transfer") assert.equal(buy.params.deposit, "1000");

  const sell: FeePlan = { side: "sell", treasury: "fees.neyro.near", contractId: "near", amount: "7", capped: true };
  assert.equal(feeReceiver(sell), "fees.neyro.near");
  const transfer = feeActions(sell)[0]!;
  assert.equal(transfer.type, "Transfer");
  if (transfer.type === "Transfer") assert.equal(transfer.params.deposit, "7");
});

test("a refunded swap is not a fill (the fee is only charged after a fill)", () => {
  assert.deepEqual(assessFill("sell", 100n, 100n), { filled: false, amount: 0n });
  assert.deepEqual(assessFill("sell", 100n, 7n), { filled: true, amount: 93n });
  assert.deepEqual(assessFill("buy", 0n, 0n), { filled: false, amount: 0n });
});

test("fee label", () => {
  assert.equal(feeLabel(100, 60), "1% (max $60)");
  assert.equal(feeLabel(0, 60), "0%");
});
