import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "../src/security/secrets.js";
import {
  DEFAULT_RISK_POLICY,
  assertSlippageAllowed,
  assertTradeShareAllowed
} from "../src/security/risk.js";

test("secret encryption round trips", () => {
  const key = randomBytes(32).toString("base64");
  const secret = "ed25519:example-private-key";
  const encrypted = encryptSecret(secret, key);

  assert.notEqual(encrypted.ciphertext, secret);
  assert.equal(decryptSecret(encrypted, key), secret);
});

test("secret decryption rejects the wrong master key", () => {
  const key = randomBytes(32).toString("base64");
  const wrongKey = randomBytes(32).toString("base64");
  const encrypted = encryptSecret("private-key", key);

  assert.throws(() => decryptSecret(encrypted, wrongKey));
});

test("slippage policy accepts the default limit", () => {
  assert.doesNotThrow(() =>
    assertSlippageAllowed(DEFAULT_RISK_POLICY.maxSlippageBps)
  );
});

test("slippage policy rejects values above the limit", () => {
  assert.throws(() =>
    assertSlippageAllowed(DEFAULT_RISK_POLICY.maxSlippageBps + 1)
  );
});


test("version 2 secrets are bound to their associated data", () => {
  const key = randomBytes(32).toString("base64");
  const encrypted = encryptSecret("private-key", key, "wallet:alice");

  assert.equal(encrypted.version, 2);
  assert.equal(decryptSecret(encrypted, key, "wallet:alice"), "private-key");
  assert.throws(() => decryptSecret(encrypted, key, "wallet:mallory"));
  assert.throws(() => decryptSecret(encrypted, key));
});

test("legacy version 1 secrets still decrypt", () => {
  const key = randomBytes(32).toString("base64");
  const encrypted = encryptSecret("private-key", key);

  assert.equal(encrypted.version, 1);
  assert.equal(decryptSecret(encrypted, key), "private-key");
});

test("trade-size policy applies symmetrically", () => {
  assert.doesNotThrow(() => assertTradeShareAllowed(25n, 100n, 2500));
  assert.throws(() => assertTradeShareAllowed(26n, 100n, 2500), /maximum of 25%/);
});
