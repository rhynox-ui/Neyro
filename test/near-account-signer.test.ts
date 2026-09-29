import test from "node:test";
import assert from "node:assert/strict";
import { classifyFinalExecutionStatus, assertAllowedNearReceiver } from "../src/wallet/near-account-signer.js";

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


test("RHEA aggregate contract is explicitly allowed", () => {
  assert.doesNotThrow(() =>
    assertAllowedNearReceiver("aggregatedex.near", [])
  );
});

test("token contracts supplied by the trade are allowed", () => {
  assert.doesNotThrow(() =>
    assertAllowedNearReceiver("token.example.near", ["token.example.near"])
  );
});

test("unexpected NEAR receivers are blocked", () => {
  assert.throws(
    () => assertAllowedNearReceiver("malicious.example.near", ["token.example.near"]),
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
  const { extractRheaRouteTokens } = await import("../src/rhea/registration.js");
  assert.deepEqual(
    extractRheaRouteTokens({}, ["wrap.near", "foo.near"]),
    ["wrap.near", "foo.near"]
  );
});
