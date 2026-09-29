process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.NODE_ENV = "test";
process.env.NEAR_NETWORK = "mainnet";
process.env.NEAR_RPC_URL = "https://rpc.mainnet.fastnear.com";
process.env.DATABASE_URL = "https://example.com/test-db";

import test from "node:test";
import assert from "node:assert/strict";

const { parseRegistrationResult, isTokenStorageRegistered } =
  await import("../src/rhea/registration.js");

test("RHEA registration parser accepts boolean arrays", () => {
  assert.deepEqual(parseRegistrationResult([true, false], ["a.near", "b.near"]), [true, false]);
});

test("RHEA registration parser accepts a scalar for one token", () => {
  assert.deepEqual(parseRegistrationResult(true, ["a.near"]), [true]);
});

test("RHEA registration parser accepts nested result arrays", () => {
  assert.deepEqual(parseRegistrationResult({ result: [false, true] }, ["a.near", "b.near"]), [false, true]);
});

test("RHEA registration parser rejects mismatched lengths", () => {
  assert.throws(
    () => parseRegistrationResult([true], ["a.near", "b.near"]),
    /length did not match/
  );
});

test("RHEA registration parser rejects scalar for multiple tokens", () => {
  assert.throws(
    () => parseRegistrationResult(true, ["a.near", "b.near"]),
    /scalar registration result/
  );
});

test("RHEA registration parser rejects unknown payloads", () => {
  assert.throws(
    () => parseRegistrationResult({ registered: ["yes"] }, ["a.near"]),
    /unrecognized token registration response/
  );
});

test("NEP-141 storage registration requires positive total", () => {
  assert.equal(isTokenStorageRegistered({ total: "5000", available: "0" }), true);
  assert.equal(isTokenStorageRegistered({ total: "0", available: "0" }), false);
  assert.equal(isTokenStorageRegistered(null), false);
});
