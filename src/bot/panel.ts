import { InlineKeyboard, type Bot, type Context } from "grammy";
import { formatUnits, parseUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { fetchNearMarket, type NearMarket } from "../market/dexscreener.js";
import { fetchLaunchByToken, isNearlyToken, nearlyMarket } from "../discovery/nearly.js";

/** DexScreener first; brand-new NEARly tokens fall back to the factory's launch record. */
async function loadMarket(
  address: string,
  nearUsd: () => Promise<number | null>,
  pricer: () => Promise<QuotePricer>
): Promise<NearMarket | null> {
  const market = await fetchNearMarket(address).catch((error) => {
    console.warn("DexScreener lookup failed:", error);
    return null;
  });
  if (!isNearlyToken(address)) {
    if (market && market.cachedAtMs === undefined) return market;
    // APIs refused or have no pair yet: price any token from its RHEA pool.
    const live = await onchainMarket(address, await pricer()).catch((error) => {
      console.warn("On-chain pool pricing failed:", { address, error: String(error) });
      return null;
    });
    if (!live) return market;
    if (!market) return live;
    return {
      ...market,
      priceUsd: live.priceUsd ?? market.priceUsd,
      marketCapUsd: live.marketCapUsd ?? market.marketCapUsd,
      fdvUsd: live.fdvUsd ?? market.fdvUsd,
      liquidityUsd: live.liquidityUsd ?? market.liquidityUsd
    };
  }
  if (market && market.cachedAtMs === undefined) {
    // GeckoTerminal has no project links; NEARly launches carry their own.
    if (market.links.length) return market;
    const launch = await fetchLaunchByToken(address).catch(() => null);
    return launch?.links.length ? { ...market, links: launch.links } : market;
  }

  // DexScreener refused (rate limit) or has no pair: NEARly tokens are
  // priced live from their RHEA DCL pool. A cached DexScreener result still
  // supplies the logo, links and 24h stats.
  const launch = await fetchLaunchByToken(address).catch(() => null);
  if (!launch) return market;
  const live = await nearlyMarket(launch, await nearUsd());
  if (!market) return live;
  return {
    ...market,
    priceUsd: live.priceUsd ?? market.priceUsd,
    marketCapUsd: live.marketCapUsd ?? market.marketCapUsd,
    fdvUsd: live.fdvUsd ?? market.fdvUsd,
    liquidityUsd: live.liquidityUsd ?? market.liquidityUsd
  };
}
import { onchainMarket, type QuotePricer } from "../market/onchain.js";
import { ftBalanceOf, ftMetadata } from "../near/ft.js";
import { getNearBalance, tradableNear } from "../near/account.js";
import { decodeIcon } from "../market/icon.js";
import { looksLikeContractId } from "../near/tokens.js";
import { stripAssetPrefix, type NearToken } from "../rhea/client.js";
import type { TradingService, ExecutionResult } from "../trading/service.js";
import type { WalletService } from "../wallet/service.js";
import { config, FEE_BPS, TRADING_ENABLED } from "../config.js";
import { formatNativeFee } from "../trading/fee.js";
import { userMessage } from "../errors.js";
import { describeRoute, priceImpactWarning } from "../trading/outcome.js";
import { deleteIncoming, keepScreen, replyNotice, trackScreen } from "./screens.js";
import { defaultStateStore, type StateStore } from "../state/store.js";
import {
  DEFAULT_SLIPPAGE_PCT,
  MAX_SLIPPAGE_PCT,
  MIN_SLIPPAGE_PCT,
  type SettingsService
} from "../settings/service.js";

/** Buy presets in NEAR, largest first (Mango shows 0.1 / 0.05 SOL). */
export const BUY_PRESETS = ["5", "1"] as const;
export const SELL_PERCENTS = ["25%", "50%", "75%", "100%"] as const;
export const SLIPPAGE_PRESETS = [5, 10, 15] as const;
export { DEFAULT_SLIPPAGE_PCT, MIN_SLIPPAGE_PCT, MAX_SLIPPAGE_PCT };
/** "1% (max $60)", or "0%" when no treasury is configured. */
export function feeLabel(bps = FEE_BPS, capUsd = config.PROTOCOL_FEE_CAP_USD): string {
  return bps > 0 ? `${bps / 100}% (max $${capUsd})` : "0%";
}

export type Side = "buy" | "sell";

export type PanelState = {
  token: NearToken;
  market: NearMarket | null;
  side: Side;
  amountHuman: string | null;
  slippagePct: number;
  awaiting?: "amount" | "slippage";
  /** Sell preset picked (25/50/75/100), shown on the card and button. */
  sellPct?: number;
  /** The Telegram message showing this panel, so it can be updated in place. */
  chatId?: number;
  messageId?: number;
};

/** Plain NEAR contract id for display and lookups (RHEA ids may carry "nep141:"). */
function contractIdOf(token: NearToken): string {
  return stripAssetPrefix(token.contractAddress ?? token.address);
}

/** An open panel is a browsing session; after this it asks to paste again. */
const PANEL_TTL_MS = 30 * 60 * 1000;

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export function pct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function ageLabel(createdAtMs: number | null, now = Date.now()): string {
  if (!createdAtMs) return "unknown";
  const minutes = Math.max(0, Math.floor((now - createdAtMs) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function liquidityShare(market: NearMarket): string {
  const { liquidityUsd, marketCapUsd } = market;
  if (!liquidityUsd || !marketCapUsd || marketCapUsd <= 0) return "";
  return `  •  ${((liquidityUsd / marketCapUsd) * 100).toFixed(2)}% of mcap`;
}

/** "1.2K", "3.4M", "0.0123": short amounts for buttons. */
export function compactAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1e9) return `${Number((value / 1e9).toPrecision(3))}B`;
  if (value >= 1e6) return `${Number((value / 1e6).toPrecision(3))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toPrecision(3))}K`;
  return String(Number(value.toPrecision(3)));
}

/** "1,234.567891" — readable token amounts (at most 6 decimals). */
export function tokenAmount(human: string): string {
  const value = Number(human);
  if (!Number.isFinite(value)) return human;
  return value.toLocaleString("en-US", { maximumFractionDigits: value >= 1 ? 4 : 6 });
}

function usdOf(amount: number, priceUsd: string | null | undefined): string {
  const price = Number(priceUsd);
  if (!priceUsd || !Number.isFinite(price) || !(amount > 0)) return "";
  const usd = amount * price;
  return ` (~$${usd < 0.01 ? usd.toPrecision(2) : usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
}

/**
 * `ownedHuman`: the active wallet's token balance, null when it couldn't be
 * read. `nearHuman`: NEAR available to trade, shown on the buy side.
 */
export function panelText(state: PanelState, ownedHuman: string | null, nearHuman: string | null = null): string {
  const { token, market, side } = state;
  const symbol = escapeHtml(market?.symbol ?? token.symbol);
  const name = escapeHtml(market?.name ?? token.symbol);
  const owned = ownedHuman === null ? null : Number(ownedHuman);
  const amount = Number(state.amountHuman);
  const share = state.sellPct ?? (owned && amount > 0 ? Math.min(100, (amount / owned) * 100) : null);
  const selected = !state.amountHuman
    ? "Not selected"
    : side === "buy"
      ? `${escapeHtml(state.amountHuman)} NEAR`
      : `${escapeHtml(tokenAmount(state.amountHuman))} ${symbol}${share !== null ? ` · ${Number(share.toFixed(1))}% of holdings` : ""}${usdOf(amount, market?.priceUsd)}`;
  const holding = owned === null
    ? `💰 Holding: unavailable (tap Refresh)`
    : `💰 Holding: ${escapeHtml(tokenAmount(ownedHuman!))} ${symbol}${usdOf(owned, market?.priceUsd)}`;

  const marketLines = market
    ? [
        `💵 Price: ${market.priceUsd ? `$${Number(market.priceUsd).toPrecision(8)}` : "—"}`,
        `📊 Mcap: ${money(market.marketCapUsd)}${market.fdvUsd && market.fdvUsd !== market.marketCapUsd ? `  •  FDV: ${money(market.fdvUsd)}` : ""}`,
        `💧 Liq: ${money(market.liquidityUsd)}${liquidityShare(market)}`,
        `📈 24h: ${pct(market.priceChange24hPct)}  •  Vol: ${money(market.volume24hUsd)}`,
        `🔄 24h Txns: ${market.txns24hBuys ?? "—"} buys / ${market.txns24hSells ?? "—"} sells`,
        ...(market.pairCreatedAtMs ? [`⏳ Pair age: ${ageLabel(market.pairCreatedAtMs)}`] : []),
        ...(market.cachedAtMs !== undefined
          ? [`🕒 24h stats from ${ageLabel(market.cachedAtMs)} ago (market data busy)`]
          : market.onchain
            ? ["🛰 Live on-chain price. 24h stats will show when market data is available."]
            : []),
        ...(market.links.length
          ? [`🔗 ${market.links.map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`).join("  •  ")}`]
          : [])
      ]
    : ["📉 No market data yet: no RHEA pool found against NEAR or LINEAR, and market APIs didn't answer. Tap Refresh in a minute."];

  return [
    `🪙 ${name} (${symbol})`,
    `Ⓝ NEAR  •  ${escapeHtml(market?.dex ?? "rhea")}  •  ${escapeHtml(market?.pairLabel ?? `${token.symbol} / NEAR`)}`,
    // Full contract id in a code span: Telegram copies it on tap.
    `<code>${escapeHtml(contractIdOf(token))}</code>`,
    "",
    ...marketLines,
    // Unlisted tokens are only accepted by exact contract id; warn only when
    // nothing else (a market with liquidity) vouches for the token either.
    ...(token.listed || market ? [] : ["⚠️ Not on RHEA's token list. Verify the contract; anyone can reuse a symbol."]),
    "",
    side === "buy" ? `🟢 BUY ${symbol}` : `🔴 SELL ${symbol}`,
    `💳 Amount: ${selected}`,
    `⚙️ Slippage: ${state.slippagePct}%`,
    // Sell side always shows holdings; buy side when the user holds some.
    ...(side === "sell" || (owned !== null && owned > 0) ? [holding] : []),
    ...(side === "sell" && state.sellPct === 100
      ? ["⚠️ SELL ALL uses your entire token balance and bypasses the normal trade-size limit."]
      : []),
    ...(side === "buy" && nearHuman !== null ? [`👛 Wallet: ${escapeHtml(tokenAmount(nearHuman))} NEAR available`] : [])
  ].join("\n");
}

export function panelKeyboard(state: PanelState, ownedHuman: string | null): InlineKeyboard {
  const { side, amountHuman, slippagePct } = state;
  const symbol = state.market?.symbol ?? state.token.symbol;
  const owned = ownedHuman === null ? null : Number(ownedHuman);
  const sellAvailable = owned !== null && owned > 0;
  const tick = (value: string) =>
    (value.endsWith("%") ? state.sellPct === Number(value.slice(0, -1)) : amountHuman === value) ? " ✓" : "";
  const kb = new InlineKeyboard()
    .text("🟢 BUY", "tp:side:buy")
    .text(`🔴 SELL${sellAvailable ? "" : " 🔒"}`, "tp:side:sell")
    .row();

  if (side === "buy") {
    for (const value of BUY_PRESETS) kb.text(`${value} NEAR${tick(value)}`, `tp:amt:${value}`);
  } else {
    // Two per row, each showing how many tokens it sells.
    SELL_PERCENTS.forEach((value, i) => {
      if (i === 2) kb.row();
      const part = sellAvailable ? ` · ${compactAmount((owned! * Number(value.slice(0, -1))) / 100)}` : "";
      const label = value === "100%" ? `💯 ALL${part ? ` · ${compactAmount(owned!)}` : ""}` : `${value}${part}`;
      kb.text(`${label}${tick(value)}`, `tp:amt:${value}`);
    });
  }
  kb.row().text("✏️ Custom", "tp:custom").row();

  const isPreset = (SLIPPAGE_PRESETS as readonly number[]).includes(slippagePct);
  kb.text(`Slippage ${slippagePct === 5 ? "✓ " : ""}5%`, "tp:slip:5")
    .text(`${slippagePct === 10 ? "✓ " : ""}10%`, "tp:slip:10")
    .text(`${slippagePct === 15 ? "✓ " : ""}15%`, "tp:slip:15")
    .text(`${isPreset ? "" : `✓ ${slippagePct}% · `}✏️`, "tp:slip:custom")
    .row();

  kb.text(
    side === "buy"
      ? `🟢 BUY ${amountHuman ?? "—"} NEAR`
      : `🔴 SELL ${state.sellPct ? `${state.sellPct}%` : amountHuman ? tokenAmount(amountHuman) : "—"} ${symbol}`,
    "tp:exec"
  ).row();

  const chartUrl = state.market?.url ?? `https://dexscreener.com/near/${encodeURIComponent(contractIdOf(state.token))}`;
  kb.url("📈 Chart / Dex", chartUrl).text("🔄 Refresh", "tp:refresh");
  return kb;
}

/** The token logo as Telegram's link preview above the text, like Mango. */
function previewOptions(imageUrl: string | null) {
  return imageUrl
    ? { link_preview_options: { url: imageUrl, prefer_small_media: true, show_above_text: true } }
    : { link_preview_options: { is_disabled: true } };
}

/**
 * Logo URL: DexScreener's image when available, otherwise the token's
 * on-chain icon served by this bot (needs PUBLIC_BASE_URL).
 */
async function logoUrl(token: NearToken, market: NearMarket | null): Promise<string | null> {
  if (market?.imageUrl) return market.imageUrl;
  if (!config.PUBLIC_BASE_URL) return null;
  const contract = contractIdOf(token);
  const metadata = await ftMetadata(contract).catch(() => null);
  return decodeIcon(metadata?.icon) ? `${config.PUBLIC_BASE_URL}/icon/${encodeURIComponent(contract)}` : null;
}

function isNotModified(error: unknown): boolean {
  const description = (error as { description?: string })?.description ?? String(error);
  return description.includes("message is not modified");
}

export type PanelDeps = {
  tradingService: TradingService;
  settings: SettingsService;
  /** Where open panels live; Postgres when DATABASE_URL is set. */
  store?: StateStore;
  walletService: WalletService;
  renderExecution(result: ExecutionResult): string;
};

export function createTokenPanel({ tradingService, walletService, settings, store = defaultStateStore(), renderExecution }: PanelDeps) {
  const panels = {
    get: (userId: number) => store.get<PanelState>(userId, "panel"),
    set: (userId: number, state: PanelState) => store.set(userId, "panel", state, PANEL_TTL_MS)
  };
  const preferredSlippage = async (userId: number, side: Side) => (await settings.slippage(userId))[side];
  const rememberSlippage = (userId: number, side: Side, value: number) =>
    settings.setSlippage(userId, side, value).catch((error) => console.warn("Could not save slippage", error));

  async function ownedBalance(userId: number, token: NearToken): Promise<{ base: bigint; human: string } | null> {
    const wallet = await walletService.getWallet(userId);
    if (!wallet) return null;
    try {
      const base = await ftBalanceOf(contractIdOf(token), wallet.accountId);
      return { base, human: formatUnits(base.toString(), token.decimals) };
    } catch {
      return null;
    }
  }

  async function availableNear(userId: number): Promise<string | null> {
    const wallet = await walletService.getWallet(userId).catch(() => null);
    if (!wallet) return null;
    const balance = await getNearBalance(wallet.accountId).catch(() => null);
    return balance ? formatUnits(tradableNear(balance).toString(), 24) : null;
  }

  /**
   * Shows the panel. With `edit`, updates the panel's own message (the tapped
   * message, or the stored one after a typed reply); otherwise sends a new
   * card, which replaces the previous panel in the chat.
   */
  async function render(ctx: Context, userId: number, state: PanelState, edit: boolean): Promise<void> {
    const [owned, nearHuman] = await Promise.all([ownedBalance(userId, state.token), availableNear(userId)]);
    const text = panelText(state, owned?.human ?? null, nearHuman);
    const options = {
      parse_mode: "HTML" as const,
      ...previewOptions(await logoUrl(state.token, state.market)),
      reply_markup: panelKeyboard(state, owned?.human ?? null)
    };

    const target = edit
      ? ctx.callbackQuery?.message
        ? { chatId: ctx.callbackQuery.message.chat.id, messageId: ctx.callbackQuery.message.message_id }
        : state.chatId !== undefined && state.messageId !== undefined
          ? { chatId: state.chatId, messageId: state.messageId }
          : undefined
      : undefined;

    if (target) {
      try {
        await ctx.api.editMessageText(target.chatId, target.messageId, text, options);
        await panels.set(userId, { ...state, ...target });
        return;
      } catch (error) {
        if (isNotModified(error)) {
          await panels.set(userId, { ...state, ...target });
          return;
        }
        // Too old or deleted: fall through and send a fresh card.
      }
    }

    const sent = await ctx.reply(text, options);
    await trackScreen(ctx, "panel", sent.chat.id, sent.message_id);
    await panels.set(userId, { ...state, chatId: sent.chat.id, messageId: sent.message_id });
  }

  async function open(ctx: Context, query: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (!TRADING_ENABLED) {
      await ctx.reply("Trading uses RHEA liquidity on NEAR mainnet only; this bot is running on testnet.");
      return;
    }
    await ctx.replyWithChatAction("typing").catch(() => {});
    await deleteIncoming(ctx);
    try {
      const token = await tradingService.resolveToken(query);
      const market = await loadMarket(contractIdOf(token), () => tradingService.nearUsdPrice(), () => tradingService.quotePricer());
      await render(ctx, userId, {
        token,
        market,
        side: "buy",
        amountHuman: null,
        slippagePct: await preferredSlippage(userId, "buy")
      }, false);
    } catch (error) {
      await replyNotice(ctx, `❌ ${userMessage(error, "Couldn't load that token right now")}`);
    }
  }

  async function withPanel(ctx: Context, handler: (userId: number, state: PanelState) => Promise<void>) {
    const userId = ctx.from?.id;
    const state = userId ? await panels.get(userId) : undefined;
    if (!userId || !state) {
      await ctx.answerCallbackQuery("Token panel expired. Paste the contract id again.");
      return;
    }
    await handler(userId, state);
  }

  function register(bot: Bot): void {
    const pm = bot.chatType("private");

    pm.callbackQuery(/^tp:side:(buy|sell)$/, (ctx) => withPanel(ctx, async (userId, state) => {
      const side = ctx.match[1] as Side;
      // The sell side always opens, so holdings and the % choices are visible;
      // selling itself is refused when the balance is 0 (see tp:amt / quote).
      await ctx.answerCallbackQuery();
      await render(ctx, userId, { ...state, side, amountHuman: null, sellPct: undefined, slippagePct: await preferredSlippage(userId, side) }, true);
    }));

    pm.callbackQuery(/^tp:amt:(\d+(?:\.\d+)?%?)$/, (ctx) => withPanel(ctx, async (userId, state) => {
      const raw = ctx.match[1]!;
      let amountHuman = raw;
      let sellPct: number | undefined;
      if (raw.endsWith("%")) {
        if (state.side !== "sell") return void await ctx.answerCallbackQuery();
        const owned = await ownedBalance(userId, state.token);
        if (!owned) return void await ctx.answerCallbackQuery(`Couldn't check your ${state.token.symbol} balance. Try again.`);
        const base = (owned.base * BigInt(raw.slice(0, -1))) / 100n;
        if (base === 0n) return void await ctx.answerCallbackQuery(`You don't hold any ${state.token.symbol} in this wallet.`);
        amountHuman = formatUnits(base.toString(), state.token.decimals);
        sellPct = Number(raw.slice(0, -1));
      }
      await ctx.answerCallbackQuery();
      await render(ctx, userId, { ...state, amountHuman, sellPct }, true);
    }));

    pm.callbackQuery("tp:custom", (ctx) => withPanel(ctx, async (userId, state) => {
      await panels.set(userId, { ...state, awaiting: "amount" });
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`✏️ Enter the amount of ${state.side === "buy" ? "NEAR" : escapeHtml(state.token.symbol)} to ${state.side}.`, { parse_mode: "HTML" });
    }));

    pm.callbackQuery(/^tp:slip:(\d+|custom)$/, (ctx) => withPanel(ctx, async (userId, state) => {
      const raw = ctx.match[1]!;
      await ctx.answerCallbackQuery();
      if (raw === "custom") {
        await panels.set(userId, { ...state, awaiting: "slippage" });
        await ctx.editMessageText(`✏️ Enter a slippage tolerance between ${MIN_SLIPPAGE_PCT} and ${MAX_SLIPPAGE_PCT}% (e.g. 3).`);
        return;
      }
      const value = Number(raw);
      await rememberSlippage(userId, state.side, value);
      await render(ctx, userId, { ...state, slippagePct: value }, true);
    }));

    pm.callbackQuery("tp:refresh", (ctx) => withPanel(ctx, async (userId, state) => {
      await ctx.answerCallbackQuery("Refreshing…");
      const market = (await loadMarket(contractIdOf(state.token), () => tradingService.nearUsdPrice(), () => tradingService.quotePricer())) ?? state.market;
      await render(ctx, userId, { ...state, market }, true);
    }));

    pm.callbackQuery("tp:exec", (ctx) => withPanel(ctx, async (userId, state) => {
      if (!state.amountHuman) return void await ctx.answerCallbackQuery("Choose an amount first.");
      await ctx.answerCallbackQuery("Getting a quote…");
      try {
        const prepared = await tradingService.prepare(
          userId,
          state.side,
          state.token.address,
          state.amountHuman,
          Math.round(state.slippagePct * 100)
        );
        const out = prepared.quote.tokenOut;
        const expected = formatUnits(prepared.quote.expectedOut, out.decimals ?? 0);
        const minimum = formatUnits(prepared.quote.minAmountOut, out.decimals ?? 0);
        const outSymbol = escapeHtml(out.symbol ?? out.address);
        const inSymbol = escapeHtml(prepared.request.tokenIn.symbol ?? prepared.request.tokenIn.address);
        const seconds = Math.max(0, Math.round((prepared.expiresAt - Date.now()) / 1000));
        await ctx.editMessageText(
          [
            `${state.side === "buy" ? "🟢 BUY" : "🔴 SELL"} ${escapeHtml(state.token.symbol)}`,
            `You spend: ${escapeHtml(state.amountHuman)} ${inSymbol}`,
            `Expected: ${expected} ${outSymbol}`,
            `Minimum: ${minimum} ${outSymbol}`,
            ...(prepared.fee
              ? [
                  `Protocol fee: ${formatUnits(prepared.fee.amount, 24)} NEAR${prepared.fee.capped ? " (capped)" : ""}`,
                  `Swapping: ${formatUnits(prepared.request.amountIn, prepared.request.tokenIn.decimals ?? 0)} ${inSymbol}`
                ]
              : []),
            `Slippage: ${state.slippagePct}%`,
            `Router: ${escapeHtml(describeRoute(prepared.quote.direct ? undefined : prepared.quote.raw?.route, prepared.quote.raw?.alternatives?.length ?? 0))}`,
            ...(priceImpactWarning(prepared.priceImpact) ? ["", escapeHtml(priceImpactWarning(prepared.priceImpact)!)] : []),
            "",
            `Quote expires in ${seconds}s. Confirm trade?`
          ].join("\n"),
          {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            reply_markup: new InlineKeyboard()
              .text("✅ Confirm", `tp:confirm:${prepared.id}`)
              .text("❌ Cancel", `tp:cancel:${prepared.id}`)
          }
        );
      } catch (error) {
        console.error("Panel quote error:", error);
        await replyNotice(ctx, `❌ ${userMessage(error, "Unable to create a quote right now")}`);
      }
    }));

    pm.callbackQuery(/^tp:confirm:([a-f0-9]{16})$/, async (ctx) => {
      await ctx.answerCallbackQuery("Executing trade…");
      await ctx.editMessageReplyMarkup();
      const userId = ctx.from.id;
      const state = await panels.get(userId);
      try {
        const result = await tradingService.execute(userId, ctx.match[1]!);
        if (!state) return void await ctx.editMessageText(renderExecution(result), { parse_mode: "HTML" });
        // Receipt with the panel underneath, flipped to the opposite side
        // after a fill so the next action (sell what you bought) is one tap.
        const next: PanelState = {
          ...state,
          side: result.status === "filled" || result.status === "submitted"
            ? (state.side === "buy" ? "sell" : "buy")
            : state.side,
          amountHuman: null
        };
        next.slippagePct = await preferredSlippage(userId, next.side);
        const owned = await ownedBalance(userId, state.token);
        // The receipt stays in the chat; a fresh panel follows below it.
        await ctx.editMessageText(
          renderExecution(result) + (owned && owned.base > 0n ? `\n💰 You now hold ${escapeHtml(owned.human)} ${escapeHtml(state.token.symbol)}` : ""),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        await keepScreen(ctx, "panel");
        await render(ctx, userId, { ...next, chatId: undefined, messageId: undefined }, false);
      } catch (error) {
        console.error("Panel execution error:", error);
        await ctx.editMessageText(`❌ ${userMessage(error, "Trade could not be executed")}`);
      }
    });

    pm.callbackQuery(/^tp:cancel:([a-f0-9]{16})$/, async (ctx) => {
      await tradingService.cancel(ctx.from.id, ctx.match[1]!);
      await ctx.answerCallbackQuery("Cancelled");
      const state = await panels.get(ctx.from.id);
      if (state) await render(ctx, ctx.from.id, { ...state, amountHuman: null }, true);
      else await ctx.editMessageText("❌ Trade cancelled.");
    });

    // Custom amount/slippage replies, and pasted contract ids.
    pm.on("message:text", async (ctx, next) => {
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return next();
      const userId = ctx.from.id;
      const state = await panels.get(userId);

      if (state?.awaiting === "amount") {
        await deleteIncoming(ctx);
        if (!/^\d+(\.\d+)?$/.test(text) || !(Number(text) > 0)) {
          return void await replyNotice(ctx, "Enter a valid positive amount.");
        }
        if (state.side === "sell") {
          const owned = await ownedBalance(userId, state.token);
          let requested: bigint;
          try {
            requested = BigInt(parseUnits(text, state.token.decimals));
          } catch {
            return void await replyNotice(ctx, `Too many decimal places for ${state.token.symbol}.`);
          }
          if (owned && requested > owned.base) {
            return void await replyNotice(ctx, `You only have ${owned.human} ${state.token.symbol}.`);
          }
        }
        return void await render(ctx, userId, { ...state, awaiting: undefined, amountHuman: text, sellPct: undefined }, true);
      }

      if (state?.awaiting === "slippage") {
        await deleteIncoming(ctx);
        const value = Number(text.replace(/%$/, ""));
        if (!Number.isFinite(value) || value < MIN_SLIPPAGE_PCT || value > MAX_SLIPPAGE_PCT) {
          return void await replyNotice(ctx, `Enter a number between ${MIN_SLIPPAGE_PCT} and ${MAX_SLIPPAGE_PCT}.`);
        }
        const rounded = Math.round(value * 10) / 10;
        await rememberSlippage(userId, state.side, rounded);
        return void await render(ctx, userId, { ...state, awaiting: undefined, slippagePct: rounded }, true);
      }

      const candidate = text.toLowerCase();
      if (looksLikeContractId(candidate)) return void await open(ctx, candidate);
      return next();
    });
  }

  return { open, register };
}
