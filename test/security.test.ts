import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "../src/security/secrets.js";
import {
  DEFAULT_RISK_POLICY,
  assertSlippageAllowed,
  assertTradeShareAllowed,
  getSpendableBalance
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

test("trade share policy rejects values above the limit", () => {
  assert.throws(() =>
    assertTradeShareAllowed(DEFAULT_RISK_POLICY.maxTradeBpsOfBalance + 1)
  );
});

test("trade share policy accepts values at the limit", () => {
  assert.doesNotThrow(() =>
    assertTradeShareAllowed(DEFAULT_RISK_POLICY.maxTradeBpsOfBalance)
  );
});


test("spendable balance keeps the configured NEAR reserve", () => {
  assert.equal(getSpendableBalance(100n, 10n), 90n);
  assert.throws(
    () => getSpendableBalance(10n, 10n),
    /safety reserve/
  );
});
