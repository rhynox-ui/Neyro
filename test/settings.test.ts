import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { SettingsService, InMemorySettingsRepository } = await import("../src/settings/service.js");
const { renderSettings } = await import("../src/bot/register.js");
const { UserFacingError } = await import("../src/errors.js");

test("slippage defaults to 5% and persists per side", async () => {
  const repository = new InMemorySettingsRepository();
  const settings = new SettingsService(repository);
  assert.deepEqual(await settings.slippage(1), { buy: 5, sell: 5 });

  assert.equal(await settings.setSlippage(1, "sell", 12.34), 12.3);
  // A fresh service (e.g. after a restart) reads the stored value.
  assert.deepEqual(await new SettingsService(repository).slippage(1), { buy: 5, sell: 12.3 });
});

test("slippage outside 0.1–15% is refused", async () => {
  const settings = new SettingsService(new InMemorySettingsRepository());
  await assert.rejects(settings.setSlippage(1, "buy", 20), UserFacingError);
  await assert.rejects(settings.setSlippage(1, "buy", 0), UserFacingError);
});

test("settings screen ticks the active presets", () => {
  const { text, keyboard } = renderSettings({ buy: 10, sell: 5 });
  assert.match(text, /Buy slippage: 10%/);
  assert.match(text, /Protocol fee: /);
  const rows = keyboard.inline_keyboard.map((row) => row.map((b) => b.text));
  assert.deepEqual(rows, [["🟢 Buy", "5%", "10% ✓", "15%"], ["🔴 Sell", "5% ✓", "10%", "15%"]]);
});
