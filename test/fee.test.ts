import test from "node:test";
import assert from "node:assert/strict";
import { computeFee, injectFee, type FeePlan } from "../src/trading/fee.js";
import { assessFill } from "../src/trading/outcome.js";
import { functionCall } from "../src/near/actions.js";

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

const buyPlan: FeePlan = { side: "buy", treasury: "fees.neyro.near", contractId: "wrap.near", amount: "1000", capped: false };
const swapTx = () => ({
  receiverId: "wrap.near",
  actions: [
    functionCall("near_deposit", {}, 10n * TGAS, 99_000n),
    functionCall("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: "99000", msg: "{}" }, 180n * TGAS, 1n)
  ]
});

test("buy fee joins the wrap.near swap transaction, after RHEA's actions", () => {
  const { transactions, mode } = injectFee([swapTx()], buyPlan);
  assert.equal(mode, "same-transaction");
  assert.equal(transactions.length, 1);
  const methods = transactions[0]!.actions.map((a) => a.type === "FunctionCall" ? a.params.methodName : a.type);
  assert.deepEqual(methods, ["near_deposit", "ft_transfer_call", "near_deposit", "ft_transfer"]);
  const transfer = transactions[0]!.actions[3]!;
  assert.ok(transfer.type === "FunctionCall");
  assert.deepEqual(transfer.params.args, { receiver_id: "fees.neyro.near", amount: "1000", memo: "neyro fee" });
  assert.equal(transfer.params.deposit, "1");
});

test("sell fee joins the token's ft_transfer_call and registers the treasury when needed", () => {
  const sellTx = { receiverId: "meme.nearlytrade.near", actions: [functionCall("ft_transfer_call", { amount: "5" }, 180n * TGAS, 1n)] };
  const plan: FeePlan = { side: "sell", treasury: "fees.neyro.near", contractId: "meme.nearlytrade.near", amount: "7", registerTreasury: "1250000000000000000000", capped: true };
  const { transactions, mode } = injectFee([sellTx], plan);
  assert.equal(mode, "same-transaction");
  const methods = transactions[0]!.actions.map((a) => a.type === "FunctionCall" ? a.params.methodName : a.type);
  assert.deepEqual(methods, ["ft_transfer_call", "storage_deposit", "ft_transfer"]);
});

test("fee falls back to its own final transaction when it can't join the swap", () => {
  const other = { receiverId: "v2.ref-finance.near", actions: [functionCall("swap", {}, 100n * TGAS, 0n)] };
  const noTarget = injectFee([other], buyPlan);
  assert.equal(noTarget.mode, "separate-transaction");
  assert.equal(noTarget.transactions.at(-1)!.receiverId, "wrap.near");

  const full = { receiverId: "wrap.near", actions: [functionCall("ft_transfer_call", {}, 290n * TGAS, 1n)] };
  assert.equal(injectFee([full], buyPlan).mode, "separate-transaction");
  assert.equal(injectFee([swapTx()], { ...buyPlan, amount: "0" }).mode, "none");
});

test("sell fill excludes the fee paid in the same token", () => {
  // Swap refunded, fee still taken: balance drops by the fee only.
  assert.deepEqual(assessFill("sell", 100n, 93n, 7n), { filled: false, amount: 0n });
  assert.deepEqual(assessFill("sell", 100n, 0n, 7n), { filled: true, amount: 93n });
});

test("fee label", () => {
  assert.equal(feeLabel(100, 60), "1% (max $60)");
  assert.equal(feeLabel(0, 60), "0%");
});
