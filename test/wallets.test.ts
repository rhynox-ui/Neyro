import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.NEYRO_MASTER_KEY ??= randomBytes(32).toString("base64");

const { WalletService, MAX_WALLETS } = await import("../src/wallet/service.js");
const { InMemoryWalletRepository } = await import("../src/wallet/repository.js");
const { renderWalletScreen } = await import("../src/bot/register.js");
const { UserFacingError } = await import("../src/errors.js");

test("a user can hold several wallets; the newest becomes active", async () => {
  const service = new WalletService(new InMemoryWalletRepository());
  const first = await service.createWallet(1);
  assert.equal((await service.createWallet(1)).accountId, first.accountId, "createWallet keeps the existing wallet");

  const second = await service.addWallet(1);
  assert.notEqual(second.accountId, first.accountId);
  assert.equal((await service.getWallet(1))!.accountId, second.accountId);
  assert.deepEqual((await service.listWallets(1)).map((w) => w.active), [false, true]);

  await service.switchWallet(1, first.accountId);
  assert.equal((await service.getWallet(1))!.accountId, first.accountId);
});

test("wallets are capped and can't be switched to someone else's", async () => {
  const service = new WalletService(new InMemoryWalletRepository());
  for (let i = 0; i < MAX_WALLETS; i++) await service.addWallet(2);
  await assert.rejects(service.addWallet(2), UserFacingError);

  const other = await service.addWallet(3);
  await assert.rejects(service.switchWallet(2, other.accountId), UserFacingError);
});

test("signing uses the requested wallet, not whichever is active", async () => {
  const service = new WalletService(new InMemoryWalletRepository());
  const first = await service.addWallet(4);
  await service.addWallet(4); // now active
  const account = await service.getSigningAccount(4, first.accountId);
  assert.equal(account.accountId, first.accountId);
  await assert.rejects(service.getSigningAccount(4, "someone-else.near"));
});

test("wallet screen marks the active wallet and offers a new one below the cap", () => {
  const wallets = [
    { accountId: "a".repeat(64), active: false },
    { accountId: "b".repeat(64), active: true }
  ];
  const balance = { exists: true, total: 10n ** 24n, storage: 0n, available: 10n ** 24n };
  const { text, keyboard } = renderWalletScreen(wallets, balance, 5);
  assert.match(text, /Your wallets<\/b> \(2\/5\)/);
  assert.match(text, /✅ W2 · <code>bbbbbb…bbbb<\/code>/);
  assert.match(text, /Balance: 1 NEAR/);
  const rows = keyboard.inline_keyboard.map((row) => row.map((b) => (b as { callback_data: string }).callback_data));
  assert.deepEqual(rows, [["w:use:0"], ["w:use:1"], ["w:new"]]);

  const full = renderWalletScreen(Array.from({ length: 5 }, (_, i) => ({ accountId: `${i}`.repeat(64), active: i === 0 })), balance, 5);
  assert.ok(!full.keyboard.inline_keyboard.flat().some((b) => (b as { callback_data: string }).callback_data === "w:new"));
});
