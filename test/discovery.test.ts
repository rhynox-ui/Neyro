import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { parseLaunches } = await import("../src/discovery/nearly.js");
const { renderLaunchFeed } = await import("../src/bot/register.js");

// Shape of the factory's Launch JSON (contracts/factory/src/lib.rs).
const launch = (id: number, step: string, extra: Record<string, unknown> = {}) => ({
  id, token: `meme-${id}.nearlytrade.near`, creator: "dev.near", name: `Meme ${id}`, symbol: `MEME${id}`,
  icon: "data:image/png;base64,AAAA", description: "", created_at_ms: 1_000_000,
  links: { website: "https://meme.example", twitter: "javascript:alert(1)", telegram: null },
  total_supply: "1000000000000000000000000000000000", pool_id: "p", token_is_x: true,
  step, quote: "wrap.near", ...extra
});

test("parseLaunches keeps completed launches with safe links", () => {
  const parsed = parseLaunches([launch(3, "Done"), launch(2, "AddLiquidity"), launch(1, "Failed"), launch(0, "Done", { quote: "nearly.nearlytrade.near" })]);
  assert.deepEqual(parsed.map((item) => item.id), [3, 0]);
  assert.deepEqual(parsed[0]!.links, [{ label: "Website", url: "https://meme.example/" }]);
  assert.equal(parsed[1]!.quote, "nearly.nearlytrade.near");
  assert.throws(() => parseLaunches({}));
});

test("launch feed escapes names and gives each token a short button", () => {
  const [item] = parseLaunches([launch(12345, "Done", { name: "<b>Rug</b>" })]);
  const { text, keyboard } = renderLaunchFeed([item!], 1_000_000 + 12 * 60_000);
  assert.ok(text.includes("<b>&lt;b&gt;Rug&lt;/b&gt;</b> ($MEME12345) · 12m · vs NEAR"));
  assert.match(text, /<code>meme-12345.nearlytrade.near<\/code>/);
  const buttons = keyboard.inline_keyboard.flat();
  assert.deepEqual(buttons.map((b) => (b as { callback_data: string }).callback_data), ["nl:12345", "nl:feed"]);
});

test("NEARly launches give brand-new tokens a card before DexScreener lists them", async () => {
  const { launchAsMarket, isNearlyToken } = await import("../src/discovery/nearly.js");
  const { panelText } = await import("../src/bot/panel.js");
  const [item] = parseLaunches([launch(7, "Done")]);
  const market = launchAsMarket(item!);
  assert.ok(isNearlyToken(item!.token));
  assert.ok(!isNearlyToken("usdt.tether-token.near"));
  const token = { chain: "near", address: item!.token, contractAddress: item!.token, symbol: "MEME7", decimals: 18, isNative: false, listed: false } as const;
  const text = panelText({ token, market, side: "buy", amountHuman: null, slippagePct: 5 }, null);
  assert.match(text, /🪙 Meme 7 \(MEME7\)/);
  assert.match(text, /rhea · NEARly  •  MEME7 \/ NEAR/);
  assert.match(text, /💵 Price: —/);
});
