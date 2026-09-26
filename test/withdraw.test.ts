import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { buildWithdrawTransactions, isImplicitAccount } = await import("../src/wallet/withdraw.js");
const { renderWithdrawConfirm, renderWithdrawResult } = await import("../src/bot/register.js");

const NEAR = 10n ** 24n;
const near = { kind: "near", symbol: "NEAR", decimals: 24 } as const;
const usdt = { kind: "ft", contractId: "usdt.tether-token.near", symbol: "USDt", decimals: 6 } as const;

test("NEAR withdrawal is a single Transfer to the receiver", () => {
  assert.deepEqual(buildWithdrawTransactions({ to: "alice.near", asset: near, amount: 5n * NEAR, registration: 0n }), [
    { receiverId: "alice.near", actions: [{ type: "Transfer", params: { deposit: (5n * NEAR).toString() } }] }
  ]);
});

test("token withdrawal registers the receiver and transfers in one transaction", () => {
  const [tx, ...rest] = buildWithdrawTransactions({ to: "alice.near", asset: usdt, amount: 1_500_000n, registration: 1_250_000_000_000_000_000_000n });
  assert.equal(rest.length, 0);
  assert.equal(tx!.receiverId, "usdt.tether-token.near");
  const methods = tx!.actions.map((a) => a.type === "FunctionCall" ? a.params.methodName : a.type);
  assert.deepEqual(methods, ["storage_deposit", "ft_transfer"]);
  const transfer = tx!.actions[1]!;
  assert.ok(transfer.type === "FunctionCall");
  assert.deepEqual(transfer.params.args, { receiver_id: "alice.near", amount: "1500000" });
  assert.equal(transfer.params.deposit, "1");

  const registered = buildWithdrawTransactions({ to: "alice.near", asset: usdt, amount: 1n, registration: 0n });
  assert.equal(registered[0]!.actions.length, 1);
});

test("implicit accounts are recognised", () => {
  assert.ok(isImplicitAccount("f".repeat(64)));
  assert.ok(isImplicitAccount(`0x${"a".repeat(40)}`));
  assert.ok(!isImplicitAccount("alice.near"));
});

test("withdrawal screens show the exact amount, the full address and a warning", () => {
  const plan = { id: "x", userId: 1, from: "me.near", to: "alice.near", asset: usdt, amount: 1_500_000n, registration: 1_250_000_000_000_000_000_000n, expiresAt: 0 };
  const confirm = renderWithdrawConfirm(plan);
  assert.match(confirm, /Amount: 1.5 USDt/);
  assert.match(confirm, /To: <code>alice.near<\/code>/);
  assert.match(confirm, /Receiver registration: 0.00125 NEAR/);
  assert.match(confirm, /can't be reversed/);

  assert.match(renderWithdrawResult(plan, { status: "executed", txHashes: ["abcdefghij"] }), /Sent 1.5 USDt/);
  assert.match(renderWithdrawResult(plan, { status: "unknown", txHashes: ["abcdefghij"] }), /Do not retry/);
  assert.match(renderWithdrawResult(plan, { status: "failed", txHashes: [] }), /Nothing was sent/);
});
