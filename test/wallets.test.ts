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
  assert.deepEqual(rows, [["w:use:0"], ["w:use:1"], ["w:new"], ["w:export"]]);

  const full = renderWalletScreen(Array.from({ length: 5 }, (_, i) => ({ accountId: `${i}`.repeat(64), active: i === 0 })), balance, 5);
  assert.ok(!full.keyboard.inline_keyboard.flat().some((b) => (b as { callback_data: string }).callback_data === "w:new"));
});

test("exported private key controls the active wallet and is shown hidden", async () => {
  const { KeyPair, keyToImplicitAddress } = await import("near-api-js");
  const { renderPrivateKey, renderExportWarning } = await import("../src/bot/register.js");
  const service = new WalletService(new InMemoryWalletRepository());
  const wallet = await service.createWallet(9);
  const { accountId, privateKey } = await service.exportPrivateKey(9);
  assert.equal(accountId, wallet.accountId);
  assert.match(privateKey, /^ed25519:/);
  assert.equal(keyToImplicitAddress(KeyPair.fromString(privateKey as `ed25519:${string}`).getPublicKey()), accountId);

  const message = renderPrivateKey(accountId, privateKey);
  assert.ok(message.includes(`<tg-spoiler><code>${privateKey}</code></tg-spoiler>`));
  assert.match(renderExportWarning(accountId), /Anyone who has this key controls this wallet/);
  await assert.rejects(service.exportPrivateKey(10), UserFacingError);
});

test("key message: reminder 1h before, deletion after 24h, each once", async () => {
  const { scheduleDeletion, deleteDueMessages } = await import("../src/bot/autodelete.js");
  const { InMemoryStateStore } = await import("../src/state/store.js");
  const { KEY_MESSAGE_TTL_MS, KEY_REMINDER_BEFORE_MS, KEY_REMINDER_TEXT } = await import("../src/bot/register.js");
  const store = new InMemoryStateStore();
  const deleted: number[] = [];
  const reminders: { text: string; replyTo?: number }[] = [];
  const api = {
    deleteMessage: async (_chat: number, id: number) => { deleted.push(id); return true; },
    sendMessage: async (_chat: number, text: string, options: { reply_parameters?: { message_id: number } }) => {
      reminders.push({ text, replyTo: options.reply_parameters?.message_id });
      return {};
    }
  } as never;
  const HOUR = 60 * 60 * 1000;
  const start = Date.now();

  await scheduleDeletion(1, 100, 55, KEY_MESSAGE_TTL_MS, store, { text: KEY_REMINDER_TEXT, remindBeforeMs: KEY_REMINDER_BEFORE_MS });
  await deleteDueMessages(api, store, start + 22 * HOUR);
  assert.deepEqual([reminders.length, deleted.length], [0, 0]);

  await deleteDueMessages(api, store, start + 23 * HOUR + 1000);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0]!.replyTo, 55);
  assert.match(reminders[0]!.text, /deleted in 1 hour/);
  assert.equal(deleted.length, 0);

  await deleteDueMessages(api, store, start + 24 * HOUR + 1000);
  await deleteDueMessages(api, store, start + 25 * HOUR);
  assert.deepEqual(deleted, [55]);
  assert.equal(reminders.length, 1);
});
