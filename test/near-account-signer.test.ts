import test from "node:test";
import assert from "node:assert/strict";
import { classifyFinalExecutionStatus } from "../src/wallet/near-account-signer.js";

test("NEAR success final statuses are confirmed", () => {
  assert.equal(
    classifyFinalExecutionStatus({ SuccessValue: "" }),
    "confirmed"
  );

  assert.equal(
    classifyFinalExecutionStatus({ SuccessReceiptId: "receipt-hash" }),
    "confirmed"
  );
});

test("NEAR failure final status is rejected as failed", () => {
  assert.equal(
    classifyFinalExecutionStatus({
      Failure: { ActionError: { kind: "FunctionCallError" } }
    }),
    "failed"
  );
});

test("unknown NEAR final status fails closed", () => {
  assert.throws(
    () => classifyFinalExecutionStatus({}),
    /unknown final execution status/
  );

  assert.throws(
    () => classifyFinalExecutionStatus(undefined),
    /unknown final execution status/
  );
});
