import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFinalExecutionStatus,
  assertAllowedNearReceiver
} from "../src/wallet/near-account-signer.js";

test("NEAR success final statuses are confirmed", () => {
  assert.equal(classifyFinalExecutionStatus({ SuccessValue: "" }), "confirmed");
  assert.equal(classifyFinalExecutionStatus({ SuccessReceiptId: "receipt-hash" }), "confirmed");
});

test("NEAR failure final status is rejected as failed", () => {
  assert.equal(
    classifyFinalExecutionStatus({ Failure: { ActionError: { kind: "FunctionCallError" } } }),
    "failed"
  );
});

test("unknown NEAR final status fails closed", () => {
  assert.throws(() => classifyFinalExecutionStatus({}), /unknown final execution status/);
  assert.throws(() => classifyFinalExecutionStatus(undefined), /unknown final execution status/);
});

test("RHEA aggregate contract is explicitly allowed", () => {
  assert.doesNotThrow(() => assertAllowedNearReceiver("aggregatedex.near", []));
});

test("trade token contracts can be explicitly allowed", () => {
  assert.doesNotThrow(() =>
    assertAllowedNearReceiver("token.example.near", ["token.example.near"])
  );
});

test("unexpected receiver is blocked", () => {
  assert.throws(
    () => assertAllowedNearReceiver("unexpected.example.near", ["token.example.near"]),
    /unexpected contract/
  );
});

test("RHEA route token extraction prefers protocol-provided token list", async () => {
  const { extractRheaRouteTokens } = await import("../src/rhea/route.js");
  assert.deepEqual(
    extractRheaRouteTokens(
      { tokens: ["wrap.near", "foo.near", "wrap.near"] },
      ["fallback.near"]
    ),
    ["wrap.near", "foo.near"]
  );
});

test("RHEA registration preflight falls back to trade tokens", async () => {
  const { extractRheaRouteTokens } = await import("../src/rhea/route.js");
  assert.deepEqual(
    extractRheaRouteTokens({}, ["wrap.near", "foo.near"]),
    ["wrap.near", "foo.near"]
  );
});


test("registration validator requires explicit safe registration arguments", async () => {
  const { NearAccountSigner } = await import("../src/wallet/near-account-signer.js");
  const signer = new NearAccountSigner({} as never, { allowedReceivers: ["token.near"] });
  await assert.rejects(
    signer.signAndSendRegistrationTransactions([{
      receiverId: "token.near",
      actions: [{
        type: "FunctionCall",
        params: {
          methodName: "storage_deposit",
          args: { account_id: "alice.near", registration_only: false },
          gas: "10000000000000",
          deposit: "1"
        }
      }]
    }] as never, {}),
    /registration_only/
  );
});

test("registration validator blocks receivers outside the allowlist", async () => {
  const { NearAccountSigner } = await import("../src/wallet/near-account-signer.js");
  const signer = new NearAccountSigner({} as never, { allowedReceivers: ["token.near"] });
  await assert.rejects(
    signer.signAndSendRegistrationTransactions([{
      receiverId: "evil.near",
      actions: [{
        type: "FunctionCall",
        params: {
          methodName: "storage_deposit",
          args: { account_id: "alice.near", registration_only: true },
          gas: "10000000000000",
          deposit: "1"
        }
      }]
    }] as never, {}),
    /unexpected contract/
  );
});
