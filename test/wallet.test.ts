import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { KeyPair, keyToImplicitAddress } from "near-api-js";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { encryptSecret } = await import("../src/security/secrets.js");
const { unlockWalletKey, walletKeyContext } = await import("../src/wallet/service.js");

function storedWallet(masterKey: string, version: 1 | 2) {
  const keyPair = KeyPair.fromRandom("ed25519");
  const accountId = keyToImplicitAddress(keyPair.getPublicKey());
  const context = version === 2 ? walletKeyContext(accountId) : undefined;
  return {
    telegramUserId: 1,
    accountId,
    secret: keyPair.toString(),
    encryptedKey: encryptSecret(keyPair.toString(), masterKey, context)
  };
}

test("unlockWalletKey returns the key that controls the account", () => {
  const masterKey = randomBytes(32).toString("base64");
  for (const version of [1, 2] as const) {
    const wallet = storedWallet(masterKey, version);
    assert.equal(unlockWalletKey(wallet, masterKey), wallet.secret);
  }
});

test("unlockWalletKey rejects a key moved to another wallet row", () => {
  const masterKey = randomBytes(32).toString("base64");
  for (const version of [1, 2] as const) {
    const victim = storedWallet(masterKey, version);
    const attacker = storedWallet(masterKey, version);
    const swapped = { ...victim, encryptedKey: attacker.encryptedKey };
    assert.throws(() => unlockWalletKey(swapped, masterKey));
  }
});
