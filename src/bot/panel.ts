import { InlineKeyboard, type Bot, type Context } from "grammy";
import { formatUnits, parseUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { fetchNearMarket, type NearMarket } from "../market/dexscreener.js";
import { ftBalanceOf } from "../near/ft.js";
import { looksLikeContractId } from "../near/tokens.js";
import type { NearToken } from "../rhea/client.js";
import type { TradingService, ExecutionResult } from "../trading/service.js";
import type { WalletService } from "../wallet/service.js";
import { config, FEE_BPS, TRADING_ENABLED } from "../config.js";
import { userMessage } from "../errors.js";

/** Buy presets in NEAR, largest first (Mango shows 0.1 / 0.05 SOL). */
export const BUY_PRESETS = ["5", "1"] as const;
export const SELL_PERCENTS = ["25%", "50%", "75%", "100%"] as const;
export const SLIPPAGE_PRESETS = [5, 10, 15] as const;
export const DEFAULT_SLIPPAGE_PCT = 5;
export const MIN_SLIPPAGE_PCT = 0.1;
/** Matches DEFAULT_RISK_POLICY.maxSlippageBps. */
export const MAX_SLIPPAGE_PCT = 15;
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
};

// Per-user panel and slippage preference. Kept in memory: a panel is a
// browsing session, and an expired one just asks the user to paste again.
const panels = new Map<number, PanelState>();
const slippagePrefs = new Map<number, Record<Side, number>>();

function preferredSlippage(userId: number, side: Side): number {
  return slippagePrefs.get(userId)?.[side] ?? DEFAULT_SLIPPAGE_PCT;
}

function rememberSlippage(userId: number, side: Side, value: number): void {
  const prefs = slippagePrefs.get(userId) ?? { buy: DEFAULT_SLIPPAGE_PCT, sell: DEFAULT_SLIPPAGE_PCT };
  prefs[side] = value;
  slippagePrefs.set(userId, prefs);
}

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

export function panelText(state: PanelState, ownedHuman: string | null): string {
  const { token, market, side } = state;
  const symbol = escapeHtml(market?.symbol ?? token.symbol);
  const name = escapeHtml(market?.name ?? token.symbol);
  const selected = state.amountHuman
    ? `${escapeHtml(state.amountHuman)} ${side === "buy" ? "NEAR" : symbol}`
    : "Not selected";

  const marketLines = market
    ? [
        `💵 Price: ${market.priceUsd ? `$${Number(market.priceUsd).toPrecision(8)}` : "—"}`,
        `📊 Mcap: ${money(market.marketCapUsd)}${market.fdvUsd && market.fdvUsd !== market.marketCapUsd ? `  •  FDV: ${money(market.fdvUsd)}` : ""}`,
        `💧 Liq: ${money(market.liquidityUsd)}${liquidityShare(market)}`,
        `📈 24h: ${pct(market.priceChange24hPct)}  •  Vol: ${money(market.volume24hUsd)}`,
        `🔄 24h Txns: ${market.txns24hBuys ?? "—"} buys / ${market.txns24hSells ?? "—"} sells`,
        `⏳ Pair age: ${ageLabel(market.pairCreatedAtMs)}`,
        ...(market.links.length
          ? [`🔗 ${market.links.map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`).join("  •  ")}`]
          : [])
      ]
    : ["📉 No DexScreener market yet. New launches can take a few minutes to appear."];

  return [
    `🪙 ${name} (${symbol})`,
    `Ⓝ NEAR  •  ${escapeHtml(market?.dex ?? "rhea")}  •  ${escapeHtml(market?.pairLabel ?? `${token.symbol} / NEAR`)}`,
    // Full contract id in a code span: Telegram copies it on tap.
    `<code>${escapeHtml(token.address)}</code>`,
    "",
    ...marketLines,
    ...(token.listed ? [] : ["⚠️ Not on RHEA's token list. Verify the contract; anyone can reuse a symbol."]),
    "",
    side === "buy" ? `🟢 BUY ${symbol}` : `🔴 SELL ${symbol}`,
    `💳 Amount: ${selected}`,
    `⚙️ Slippage: ${state.slippagePct}%`,
    `💸 Protocol fee: ${feeLabel()}`,
    ...(ownedHuman && Number(ownedHuman) > 0 ? [`💰 Your balance: ${escapeHtml(ownedHuman)} ${symbol}`] : [])
  ].join("\n");
}

export function panelKeyboard(state: PanelState, ownedHuman: string | null): InlineKeyboard {
  const { side, amountHuman, slippagePct } = state;
  const symbol = state.market?.symbol ?? state.token.symbol;
  const sellAvailable = ownedHuman !== null && Number(ownedHuman) > 0;
  const tick = (value: string) => (amountHuman === value ? " ✓" : "");
  const kb = new InlineKeyboard()
    .text("🟢 BUY", "tp:side:buy")
    .text(`🔴 SELL${sellAvailable ? "" : " 🔒"}`, "tp:side:sell")
    .row();

  if (side === "buy") {
    for (const value of BUY_PRESETS) kb.text(`${value} NEAR${tick(value)}`, `tp:amt:${value}`);
  } else {
    for (const value of SELL_PERCENTS) kb.text(`${value}${tick(value)}`, `tp:amt:${value}`);
  }
  kb.row().text("✏️ Custom", "tp:custom").row();

  const isPreset = (SLIPPAGE_PRESETS as readonly number[]).includes(slippagePct);
  kb.text(`Slippage ${slippagePct === 5 ? "✓ " : ""}5%`, "tp:slip:5")
    .text(`${slippagePct === 10 ? "✓ " : ""}10%`, "tp:slip:10")
    .text(`${slippagePct === 15 ? "✓ " : ""}15%`, "tp:slip:15")
    .text(`${isPreset ? "" : `✓ ${slippagePct}% · `}✏️`, "tp:slip:custom")
    .row();

  kb.text(
    side === "buy" ? `🟢 BUY ${amountHuman ?? "—"} NEAR` : `🔴 SELL ${amountHuman ?? "—"} ${symbol}`,
    "tp:exec"
  ).row();

  const chartUrl = state.market?.url ?? `https://dexscreener.com/near/${encodeURIComponent(state.token.address)}`;
  kb.url("📈 Chart / Dex", chartUrl).text("🔄 Refresh", "tp:refresh");
  return kb;
}

/** The token logo as Telegram's link preview above the text, like Mango. */
function previewOptions(market: NearMarket | null) {
  return market?.imageUrl
    ? { link_preview_options: { url: market.imageUrl, prefer_small_media: true, show_above_text: true } }
    : { link_preview_options: { is_disabled: true } };
}

function isNotModified(error: unknown): boolean {
  const description = (error as { description?: string })?.description ?? String(error);
  return description.includes("message is not modified");
}

export type PanelDeps = {
  tradingService: TradingService;
  walletService: WalletService;
  renderExecution(result: ExecutionResult): string;
};

export function createTokenPanel({ tradingService, walletService, renderExecution }: PanelDeps) {
  async function ownedBalance(userId: number, token: NearToken): Promise<{ base: bigint; human: string } | null> {
    const wallet = await walletService.getWallet(userId);
    if (!wallet) return null;
    try {
      const base = await ftBalanceOf(token.contractAddress ?? token.address, wallet.accountId);
      return { base, human: formatUnits(base.toString(), token.decimals) };
    } catch {
      return null;
    }
  }

  async function render(ctx: Context, userId: number, state: PanelState, edit: boolean): Promise<void> {
    panels.set(userId, state);
    const owned = await ownedBalance(userId, state.token);
    const text = panelText(state, owned?.human ?? null);
    const options = {
      parse_mode: "HTML" as const,
      ...previewOptions(state.market),
      reply_markup: panelKeyboard(state, owned?.human ?? null)
    };
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, options);
      } catch (error) {
        if (!isNotModified(error)) throw error;
      }
    } else {
      await ctx.reply(text, options);
    }
  }

  async function open(ctx: Context, query: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (!TRADING_ENABLED) {
      await ctx.reply("Trading uses RHEA liquidity on NEAR mainnet only; this bot is running on testnet.");
      return;
    }
    await ctx.replyWithChatAction("typing").catch(() => {});
    try {
      const token = await tradingService.resolveToken(query);
      const market = await fetchNearMarket(token.address).catch((error) => {
        console.warn("DexScreener lookup failed:", error);
        return null;
      });
      await render(ctx, userId, {
        token,
        market,
        side: "buy",
        amountHuman: null,
        slippagePct: preferredSlippage(userId, "buy")
      }, false);
    } catch (error) {
      await ctx.reply(`❌ ${userMessage(error, "Couldn't load that token right now")}`);
    }
  }

  async function withPanel(ctx: Context, handler: (userId: number, state: PanelState) => Promise<void>) {
    const userId = ctx.from?.id;
    const state = userId ? panels.get(userId) : undefined;
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
      if (side === "sell") {
        const owned = await ownedBalance(userId, state.token);
        if (!owned || owned.base === 0n) {
          await ctx.answerCallbackQuery("You don't own this token yet.");
          return;
        }
      }
      await ctx.answerCallbackQuery();
      await render(ctx, userId, { ...state, side, amountHuman: null, slippagePct: preferredSlippage(userId, side) }, true);
    }));

    pm.callbackQuery(/^tp:amt:(\d+(?:\.\d+)?%?)$/, (ctx) => withPanel(ctx, async (userId, state) => {
      const raw = ctx.match[1]!;
      let amountHuman = raw;
      if (raw.endsWith("%")) {
        if (state.side !== "sell") return void await ctx.answerCallbackQuery();
        const owned = await ownedBalance(userId, state.token);
        if (!owned) return void await ctx.answerCallbackQuery(`Couldn't check your ${state.token.symbol} balance. Try again.`);
        const base = (owned.base * BigInt(raw.slice(0, -1))) / 100n;
        amountHuman = formatUnits(base.toString(), state.token.decimals);
      }
      await ctx.answerCallbackQuery();
      await render(ctx, userId, { ...state, amountHuman }, true);
    }));

    pm.callbackQuery("tp:custom", (ctx) => withPanel(ctx, async (userId, state) => {
      panels.set(userId, { ...state, awaiting: "amount" });
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`✏️ Enter the amount of ${state.side === "buy" ? "NEAR" : escapeHtml(state.token.symbol)} to ${state.side}.`, { parse_mode: "HTML" });
    }));

    pm.callbackQuery(/^tp:slip:(\d+|custom)$/, (ctx) => withPanel(ctx, async (userId, state) => {
      const raw = ctx.match[1]!;
      await ctx.answerCallbackQuery();
      if (raw === "custom") {
        panels.set(userId, { ...state, awaiting: "slippage" });
        await ctx.editMessageText(`✏️ Enter a slippage tolerance between ${MIN_SLIPPAGE_PCT} and ${MAX_SLIPPAGE_PCT}% (e.g. 3).`);
        return;
      }
      const value = Number(raw);
      rememberSlippage(userId, state.side, value);
      await render(ctx, userId, { ...state, slippagePct: value }, true);
    }));

    pm.callbackQuery("tp:refresh", (ctx) => withPanel(ctx, async (userId, state) => {
      await ctx.answerCallbackQuery("Refreshing…");
      const market = await fetchNearMarket(state.token.address).catch(() => state.market);
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
                  `Fee: ${formatUnits(prepared.fee.amount, prepared.request.tokenIn.decimals ?? 0)} ${inSymbol}${prepared.fee.capped ? " (capped)" : ""}`,
                  `Swapping: ${formatUnits(prepared.request.amountIn, prepared.request.tokenIn.decimals ?? 0)} ${inSymbol}`
                ]
              : []),
            `Slippage: ${state.slippagePct}%`,
            `Router: ${escapeHtml(prepared.quote.router ?? "RHEA")}`,
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
        await ctx.reply(`❌ ${userMessage(error, "Unable to create a quote right now")}`);
      }
    }));

    pm.callbackQuery(/^tp:confirm:([a-f0-9]{16})$/, async (ctx) => {
      await ctx.answerCallbackQuery("Executing trade…");
      await ctx.editMessageReplyMarkup();
      const userId = ctx.from.id;
      const state = panels.get(userId);
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
        next.slippagePct = preferredSlippage(userId, next.side);
        panels.set(userId, next);
        const owned = await ownedBalance(userId, state.token);
        await ctx.editMessageText(
          renderExecution(result) + (owned && owned.base > 0n ? `\n💰 You now hold ${escapeHtml(owned.human)} ${escapeHtml(state.token.symbol)}` : ""),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: panelKeyboard(next, owned?.human ?? null) }
        );
      } catch (error) {
        console.error("Panel execution error:", error);
        await ctx.editMessageText(`❌ ${userMessage(error, "Trade could not be executed")}`);
      }
    });

    pm.callbackQuery(/^tp:cancel:([a-f0-9]{16})$/, async (ctx) => {
      await tradingService.cancel(ctx.from.id, ctx.match[1]!);
      await ctx.answerCallbackQuery("Cancelled");
      const state = panels.get(ctx.from.id);
      if (state) await render(ctx, ctx.from.id, { ...state, amountHuman: null }, true);
      else await ctx.editMessageText("❌ Trade cancelled.");
    });

    // Custom amount/slippage replies, and pasted contract ids.
    pm.on("message:text", async (ctx, next) => {
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return next();
      const userId = ctx.from.id;
      const state = panels.get(userId);

      if (state?.awaiting === "amount") {
        if (!/^\d+(\.\d+)?$/.test(text) || !(Number(text) > 0)) {
          return void await ctx.reply("Enter a valid positive amount.");
        }
        if (state.side === "sell") {
          const owned = await ownedBalance(userId, state.token);
          let requested: bigint;
          try {
            requested = BigInt(parseUnits(text, state.token.decimals));
          } catch {
            return void await ctx.reply(`Too many decimal places for ${state.token.symbol}.`);
          }
          if (owned && requested > owned.base) {
            return void await ctx.reply(`You only have ${owned.human} ${state.token.symbol}.`);
          }
        }
        return void await render(ctx, userId, { ...state, awaiting: undefined, amountHuman: text }, false);
      }

      if (state?.awaiting === "slippage") {
        const value = Number(text.replace(/%$/, ""));
        if (!Number.isFinite(value) || value < MIN_SLIPPAGE_PCT || value > MAX_SLIPPAGE_PCT) {
          return void await ctx.reply(`Enter a number between ${MIN_SLIPPAGE_PCT} and ${MAX_SLIPPAGE_PCT}.`);
        }
        const rounded = Math.round(value * 10) / 10;
        rememberSlippage(userId, state.side, rounded);
        return void await render(ctx, userId, { ...state, awaiting: undefined, slippagePct: rounded }, false);
      }

      const candidate = text.toLowerCase();
      if (looksLikeContractId(candidate)) return void await open(ctx, candidate);
      return next();
    });
  }

  return { open, register };
}
