process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.NEAR_NETWORK ??= "mainnet";
process.env.NEAR_RPC_URL ??= "https://rpc.mainnet.fastnear.com";
process.env.DATABASE_URL ??= "https://example.com/test-db";

import test from "node:test";
import assert from "node:assert/strict";

const { classifyNearTransactionResult, hasFailure } =
  await import("../src/near/reconcile.js");

test("NEAR reconciliation confirms successful final execution", () => {
  assert.equal(classifyNearTransactionResult({ SuccessValue: "" }, []), "confirmed");
  assert.equal(classifyNearTransactionResult({ SuccessReceiptId: "r" }, [{ outcome: {} }]), "confirmed");
});

test("NEAR reconciliation fails when top-level execution failed", () => {
  assert.equal(
    classifyNearTransactionResult(
      { Failure: { ActionError: { kind: "FunctionCallError" } } },
      []
    ),
    "failed"
  );
});

test("NEAR reconciliation fails when a receipt failed", () => {
  assert.equal(
    classifyNearTransactionResult(
      { SuccessValue: "" },
      [{ outcome: { status: { Failure: { ActionError: {} } } } }]
    ),
    "failed"
  );
  assert.equal(hasFailure([{ outcome: { Failure: { ActionError: {} } } }]), true);
});

test("NEAR reconciliation fails closed on unknown status", () => {
  assert.equal(classifyNearTransactionResult({}, []), "unknown");
  assert.equal(classifyNearTransactionResult(undefined, undefined), "unknown");
});
