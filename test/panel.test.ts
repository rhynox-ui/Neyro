import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { parseDexScreenerPairs } = await import("../src/market/dexscreener.js");
const { panelText, panelKeyboard, ageLabel, money } = await import("../src/bot/panel.js");

const ADDRESS = "bagwork.nearly.near";
const pairs = [
  { chainId: "solana", baseToken: { address: ADDRESS }, liquidity: { usd: 9e9 } },
  {
    chainId: "near", dexId: "ref", url: "https://dexscreener.com/near/shallow",
    baseToken: { address: ADDRESS, name: "Bagwork", symbol: "Bagwork" },
    quoteToken: { address: "wrap.near", symbol: "WNEAR" },
    priceUsd: "0.1", liquidity: { usd: 10 }
  },
  {
    chainId: "near", dexId: "rhea", url: "https://dexscreener.com/near/deep",
    baseToken: { address: ADDRESS, name: "Bagwork", symbol: "Bagwork" },
    quoteToken: { address: "wrap.near", symbol: "WNEAR" },
    priceUsd: "0.0005207", marketCap: 506_720, fdv: 506_720, liquidity: { usd: 77_270 },
    volume: { h24: 6_180_000 }, priceChange: { h24: 953 }, txns: { h24: { buys: 45186, sells: 35133 } },
    pairCreatedAt: Date.now() - 17 * 3_600_000,
    info: {
      imageUrl: "https://cdn.example/bag.png",
      websites: [{ label: "Whitepaper <b>", url: "https://bag.example" }, { url: "javascript:alert(1)" }],
      socials: [{ type: "twitter", url: "https://x.com/bag" }, { type: "evil", url: "https://evil.example" }]
    }
  }
];

test("DexScreener parsing keeps NEAR pairs, picks the deepest, and sanitizes links", () => {
  const market = parseDexScreenerPairs(pairs, ADDRESS)!;
  assert.equal(market.dex, "rhea");
  assert.equal(market.pairLabel, "Bagwork / WNEAR");
  assert.equal(market.liquidityUsd, 77_270);
  assert.equal(market.imageUrl, "https://cdn.example/bag.png");
  assert.deepEqual(market.links, [
    { label: "Website", url: "https://bag.example/" },
    { label: "X", url: "https://x.com/bag" }
  ]);
  assert.equal(parseDexScreenerPairs({ pairs: [] }, ADDRESS), null);
  assert.equal(parseDexScreenerPairs(pairs.slice(0, 1), ADDRESS), null);
});

test("price is only reported when the token is the pair's base", () => {
  const market = parseDexScreenerPairs([{ ...pairs[2], baseToken: { address: "wrap.near" }, quoteToken: { address: ADDRESS, symbol: "Bagwork" } }], ADDRESS)!;
  assert.equal(market.priceUsd, null);
});

const token = { chain: "near", address: ADDRESS, contractAddress: ADDRESS, symbol: "Bagwork", decimals: 18, isNative: false, listed: true } as const;

test("panel text mirrors the Mango card", () => {
  const market = parseDexScreenerPairs(pairs, ADDRESS)!;
  const text = panelText({ token, market, side: "buy", amountHuman: null, slippagePct: 5 }, null);
  const lines = text.split("\n");
  assert.equal(lines[0], "🪙 Bagwork (Bagwork)");
  assert.equal(lines[1], "Ⓝ NEAR  •  rhea  •  Bagwork / WNEAR");
  assert.equal(lines[2], `<code>${ADDRESS}</code>`);
  assert.ok(text.includes("💵 Price: $0.00052070000"));
  assert.ok(text.includes("📊 Mcap: $506.72K"));
  assert.ok(text.includes("💧 Liq: $77.27K  •  15.25% of mcap"));
  assert.ok(text.includes("📈 24h: +953.00%  •  Vol: $6.18M"));
  assert.ok(text.includes("🔄 24h Txns: 45186 buys / 35133 sells"));
  assert.ok(text.includes("⏳ Pair age: 17h"));
  assert.ok(text.includes('🔗 <a href="https://bag.example/">Website</a>  •  <a href="https://x.com/bag">X</a>'));
  assert.ok(text.endsWith("🟢 BUY Bagwork\n💳 Amount: Not selected\n⚙️ Slippage: 5%"));
  assert.ok(!text.includes("Protocol fee"));
});

test("panel still renders for tokens with no market yet, and warns when unlisted", () => {
  const text = panelText({ token: { ...token, listed: false }, market: null, side: "sell", amountHuman: "3", slippagePct: 10 }, "12.5");
  assert.match(text, /No market data yet/);
  assert.match(text, /Not on RHEA's token list/);
  assert.match(text, /🔴 SELL Bagwork\n💳 Amount: 3 Bagwork · 24% of holdings/);
  assert.match(text, /💰 Holding: 12.5 Bagwork/);
});

test("sell side shows the chosen percent, holdings and their USD value", () => {
  const market = parseDexScreenerPairs(pairs, ADDRESS)!;
  const text = panelText({ token, market, side: "sell", amountHuman: "500000.123456789", sellPct: 50, slippagePct: 5 }, "1000000.24691358");
  assert.match(text, /💳 Amount: 500,000\.1235 Bagwork · 50% of holdings \(~\$260\.35\)/);
  assert.match(text, /💰 Holding: 1,000,000\.2469 Bagwork \(~\$520\.70\)/);
  assert.match(panelText({ token, market, side: "sell", amountHuman: null, slippagePct: 5 }, null), /💰 Holding: unavailable \(tap Refresh\)/);
  assert.match(panelText({ token, market, side: "buy", amountHuman: null, slippagePct: 5 }, "0", "1.5"), /👛 Wallet: 1\.5 NEAR available$/);
});

type Button = { text: string; callback_data?: string; url?: string };
const rows = (kb: { inline_keyboard: Button[][] }) => kb.inline_keyboard.map((row) => row.map((b) => b.text));

test("keyboard layout mirrors the Mango card", () => {
  const market = parseDexScreenerPairs(pairs, ADDRESS)!;
  const kb = panelKeyboard({ token, market, side: "buy", amountHuman: null, slippagePct: 5 }, null);
  assert.deepEqual(rows(kb), [
    ["🟢 BUY", "🔴 SELL 🔒"],
    ["5 NEAR", "1 NEAR"],
    ["✏️ Custom"],
    ["Slippage ✓ 5%", "10%", "15%", "✏️"],
    ["🟢 BUY — NEAR"],
    ["📈 Chart / Dex", "🔄 Refresh"]
  ]);
  assert.equal(kb.inline_keyboard[5]![0]!.url, "https://dexscreener.com/near/deep");
  for (const row of kb.inline_keyboard) for (const b of row) {
    if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
  }
});

test("sell keyboard offers percentages and marks custom slippage", () => {
  const kb = panelKeyboard({ token, market: null, side: "sell", amountHuman: "5", sellPct: 50, slippagePct: 3 }, "10");
  assert.deepEqual(rows(kb)[0], ["🟢 BUY", "🔴 SELL"]);
  assert.deepEqual(rows(kb)[1], ["25%", "50% ✓", "75%", "100%"]);
  assert.deepEqual(rows(kb)[3], ["Slippage 5%", "10%", "15%", "✓ 3% · ✏️"]);
  assert.deepEqual(rows(kb)[4], ["🔴 SELL 50% Bagwork"]);
});

test("formatting helpers", () => {
  assert.equal(money(1_234), "$1.23K");
  assert.equal(money(null), "—");
  assert.equal(ageLabel(null), "unknown");
  assert.equal(ageLabel(1_000, 1_000 + 3 * 86_400_000), "3d");
});

test("parses DexScreener's real response for NEARLY (rhea-finance DCL pair)", () => {
  // Trimmed from GET /tokens/v1/near/nearly-993927.nearlytrade.near on 2026-09-26.
  const live = [{"chainId":"near","dexId":"rhea-finance","url":"https://dexscreener.com/near/refv2-nearly-993927.nearlytrade.near:wrap.near:10000","pairAddress":"refv2-nearly-993927.nearlytrade.near:wrap.near:10000","baseToken":{"address":"nearly-993927.nearlytrade.near","name":"NEARLY","symbol":"NEARLY"},"quoteToken":{"address":"wrap.near","name":"Wrapped NEAR fungible token","symbol":"wNEAR"},"priceNative":"0.0002275","priceUsd":"0.001108","txns":{"h24":{"buys":920,"sells":786}},"volume":{"h24":495742.02},"priceChange":{"h24":106},"liquidity":{"usd":145746.94,"base":69227539,"quote":14155},"fdv":1108878,"marketCap":1108878,"pairCreatedAt":1790037431000,"info":{"imageUrl":"https://cdn.dexscreener.com/cms/images/pQvqE5Oh4ipJ_63a?width=800&height=800&quality=95&format=auto","websites":[{"url":"https://nearly.trade","label":"Website"},{"url":"https://github.com/sam3dsol/NearlyTrade","label":"Docs"}],"socials":[{"url":"https://x.com/NearlyTrade","type":"twitter"},{"url":"https://t.me/NearlyTrade","type":"telegram"}]}}];
  const market = parseDexScreenerPairs(live, "nearly-993927.nearlytrade.near")!;
  assert.equal(market.dex, "rhea-finance");
  assert.equal(market.priceUsd, "0.001108");
  assert.equal(market.marketCapUsd, 1108878);
  assert.equal(market.liquidityUsd, 145746.94);
  assert.equal(market.txns24hBuys, 920);
  assert.equal(market.priceChange24hPct, 106);
  assert.ok(market.imageUrl?.startsWith("https://cdn.dexscreener.com/"));
  assert.deepEqual(market.links.map((l) => l.label), ["Website", "Docs", "X", "Telegram"]);
});

test("DexScreener refusals fall back to the last good result", async () => {
  const { fetchNearMarket } = await import("../src/market/dexscreener.js");
  const { InMemoryStateStore } = await import("../src/state/store.js");
  const store = new InMemoryStateStore();
  const ok = (async () => new Response(JSON.stringify(pairs), { status: 200 })) as typeof fetch;
  const limited = (async () => new Response("error code: 1015", { status: 429 })) as typeof fetch;

  await assert.rejects(fetchNearMarket(ADDRESS, limited, store), /HTTP 429/);

  const fresh = (await fetchNearMarket(ADDRESS, ok, store))!;
  assert.equal(fresh.cachedAtMs, undefined);

  const cached = (await fetchNearMarket(ADDRESS, limited, store))!;
  assert.equal(cached.dex, "rhea");
  assert.equal(typeof cached.cachedAtMs, "number");
  assert.match(panelText({ token, market: cached, side: "buy", amountHuman: null, slippagePct: 5 }, null), /24h stats from \d+m ago \(market data busy\)/);
});

test("RHEA asset ids with nep141: prefixes and native NEAR are recognised", async () => {
  const { isNearNative, stripAssetPrefix } = await import("../src/rhea/client.js");
  assert.equal(stripAssetPrefix("nep141:USDT.tether-token.near"), "usdt.tether-token.near");
  assert.ok(isNearNative({ address: "nep141:wrap.near" }));
  assert.ok(isNearNative({ address: "near" }));
  assert.ok(isNearNative({ address: "x", isNative: true }));
  assert.ok(!isNearNative({ address: "nep141:usdt.tether-token.near", contractAddress: "usdt.tether-token.near" }));

  const listed = { ...token, address: `nep141:${ADDRESS}`, contractAddress: ADDRESS };
  assert.match(panelText({ token: listed, market: null, side: "buy", amountHuman: null, slippagePct: 5 }, null), new RegExp(`<code>${ADDRESS}</code>`));
});

const geckoFixture = {
  data: { id: `near_${ADDRESS}`, type: "token", attributes: {
    address: ADDRESS, name: "Bagwork", symbol: "BAG", image_url: "https://assets.geckoterminal.com/bag.png",
    price_usd: "0.0005207", fdv_usd: "506720", market_cap_usd: null, total_reserve_in_usd: "80000", volume_usd: { h24: "6180000" }
  } },
  included: [
    { id: "near_shallow", type: "pool", attributes: { name: "BAG / USDC", address: "shallow", reserve_in_usd: "10" }, relationships: { dex: { data: { id: "ref-finance" } } } },
    { id: "near_deep", type: "pool", attributes: {
      name: "BAG / wNEAR", address: "refv2-bag|wrap.near|10000", reserve_in_usd: "77270", pool_created_at: "2026-09-26T00:00:00Z",
      price_change_percentage: { h24: "953" }, transactions: { h24: { buys: 45186, sells: 35133 } }, volume_usd: { h24: "6180000" }
    }, relationships: { dex: { data: { id: "rhea-finance" } } } }
  ]
};

test("GeckoTerminal token + top pools parse into a market card", async () => {
  const { parseGeckoTerminalToken } = await import("../src/market/geckoterminal.js");
  const market = parseGeckoTerminalToken(geckoFixture, ADDRESS)!;
  assert.equal(market.dex, "rhea-finance");
  assert.equal(market.pairLabel, "BAG / wNEAR");
  assert.equal(market.priceUsd, "0.0005207");
  assert.equal(market.marketCapUsd, 506720); // falls back to FDV
  assert.equal(market.liquidityUsd, 77270);
  assert.equal(market.priceChange24hPct, 953);
  assert.equal(market.txns24hBuys, 45186);
  assert.equal(market.imageUrl, "https://assets.geckoterminal.com/bag.png");
  assert.equal(parseGeckoTerminalToken({ data: { attributes: {} }, included: [] }, ADDRESS), null);
  assert.equal(parseGeckoTerminalToken({ ...geckoFixture, data: { ...geckoFixture.data, attributes: { ...geckoFixture.data.attributes, image_url: "missing.png" } } }, ADDRESS)!.imageUrl, null);
});

test("market data falls back from DexScreener to GeckoTerminal", async () => {
  const { fetchNearMarket } = await import("../src/market/dexscreener.js");
  const { InMemoryStateStore } = await import("../src/state/store.js");
  const { resetCooldowns } = await import("../src/net/fallback.js");
  resetCooldowns();
  const fetcher = (async (url: string) => url.includes("dexscreener")
    ? new Response("error code: 1015", { status: 429 })
    : new Response(JSON.stringify(geckoFixture), { status: 200 })) as unknown as typeof fetch;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const market = (await fetchNearMarket(ADDRESS, fetcher, new InMemoryStateStore()))!;
    assert.equal(market.dex, "rhea-finance");
    assert.equal(market.volume24hUsd, 6180000);
    assert.equal(market.cachedAtMs, undefined);
  } finally {
    console.warn = warn;
  }
});

test("CoinGecko on-chain source sends the key header for its plan", async () => {
  const { fetchCoinGeckoOnchainMarket } = await import("../src/market/geckoterminal.js");
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    if (url.includes("/info")) return new Response(JSON.stringify({ data: { attributes: { twitter_handle: "umbra" } } }), { status: 200 });
    seen.push({ url, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(geckoFixture), { status: 200 });
  }) as unknown as typeof fetch;

  const market = (await fetchCoinGeckoOnchainMarket(ADDRESS, "demo-key", "demo", fetcher))!;
  assert.equal(market.volume24hUsd, 6180000);
  assert.deepEqual(market.links, [{ label: "X", url: "https://x.com/umbra" }]);
  assert.equal(seen[0]!.url, `https://api.coingecko.com/api/v3/onchain/networks/near/tokens/${ADDRESS}?include=top_pools`);
  assert.equal(seen[0]!.headers["x-cg-demo-api-key"], "demo-key");

  await fetchCoinGeckoOnchainMarket(ADDRESS, "pro-key", "pro", fetcher);
  assert.ok(seen[1]!.url.startsWith("https://pro-api.coingecko.com/"));
  assert.equal(seen[1]!.headers["x-cg-pro-api-key"], "pro-key");
});

test("CoinGecko token info becomes safe links", async () => {
  const { parseCoinGeckoTokenInfo } = await import("../src/market/geckoterminal.js");
  assert.deepEqual(parseCoinGeckoTokenInfo({ data: { attributes: {
    websites: ["https://umbra.fun", "javascript:alert(1)"],
    twitter_handle: "@umbrafun",
    telegram_handle: "umbra fun <x>",
    discord_url: "https://discord.gg/umbra"
  } } }), [
    { label: "Website", url: "https://umbra.fun/" },
    { label: "X", url: "https://x.com/umbrafun" },
    { label: "Discord", url: "https://discord.gg/umbra" }
  ]);
});
