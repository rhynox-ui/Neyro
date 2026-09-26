import { InlineKeyboard, type Bot, type Context } from "grammy";
import { mainMenu } from "./menu.js";
import { WalletService } from "../wallet/service.js";
import { getNearBalance, type NearBalance } from "../near/account.js";
import { formatUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { TradingService } from "../trading/service.js";
import { PortfolioService, type PortfolioAsset } from "../portfolio/service.js";
import type { ExecutionResult } from "../trading/service.js";
import { config } from "../config.js";
import { userMessage } from "../errors.js";

const walletService = new WalletService();
const tradingService = new TradingService(walletService);
const portfolioService = new PortfolioService();

const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const code = (text: string) => `<code>${escapeHtml(text)}</code>`;

export function formatNear(yocto: bigint): string {
  return formatUnits(yocto.toString(), 24);
}

function explorerTx(txHash: string): string {
  const host = config.NEAR_NETWORK === "mainnet" ? "nearblocks.io" : "testnet.nearblocks.io";
  return `https://${host}/txns/${txHash}`;
}

/** HTML message for a trade outcome. */
export function renderExecution(result: ExecutionResult): string {
  const links = result.txHashes
    .map((hash) => `<a href="${explorerTx(hash)}">${escapeHtml(hash.slice(0, 8))}…</a>`)
    .join("\n");
  const txs = links ? `\n\n${links}` : "";
  const reason = result.reason ? escapeHtml(result.reason) : undefined;
  switch (result.status) {
    case "filled":
      return `✅ <b>Trade filled</b>${txs}`;
    case "submitted":
      return `✅ <b>Trade executed on chain.</b> Fill could not be verified yet; check /portfolio.${txs}`;
    case "reverted":
      return `↩️ <b>Trade did not fill.</b> ${reason ?? "The swap failed on chain"}.\nYour tokens were not exchanged; only gas (and any storage deposit) was spent.${txs}`;
    case "partial":
      return `⚠️ <b>Trade partially executed.</b> Some transactions were rejected; check /portfolio before retrying.${txs}`;
    case "unknown":
      return `⏳ <b>Trade status unknown.</b> The transaction may still land. <b>Do not retry</b>; check the explorer link.${txs}`;
    case "failed":
      return `❌ <b>Trade failed before reaching the chain.</b> Nothing was spent; you can retry.${reason ? `\n\n${reason}` : ""}`;
  }
}

export function renderBalance(balance: NearBalance): string {
  if (!balance.exists) return "0 NEAR (not funded yet)";
  const held = balance.total - balance.available;
  return held > 0n
    ? `${formatNear(balance.available)} NEAR available (${formatNear(held)} held for storage)`
    : `${formatNear(balance.available)} NEAR`;
}

export function renderPortfolio(near: NearBalance, assets: readonly PortfolioAsset[]): string {
  const lines = assets.map((asset) =>
    `• ${escapeHtml(asset.balance)} <b>${escapeHtml(asset.symbol)}</b> ${code(asset.contractId)}`
  );
  return [
    "💼 <b>Portfolio</b>",
    "",
    `• ${renderBalance(near)}`,
    ...(lines.length ? lines : ["No token balances yet."])
  ].join("\n");
}

async function requireWallet(ctx: Context) {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    await ctx.reply("❌ Telegram user identity is unavailable.");
    return undefined;
  }
  const wallet = await walletService.getWallet(telegramUserId);
  if (!wallet) {
    await ctx.reply("👛 No wallet yet. Use /wallet to create one.");
    return undefined;
  }
  return wallet;
}

async function showPortfolio(ctx: Context) {
  const wallet = await requireWallet(ctx);
  if (!wallet) return;
  try {
    const [near, assets] = await Promise.all([
      getNearBalance(wallet.accountId),
      portfolioService.getPortfolio(wallet.accountId)
    ]);
    await ctx.reply(renderPortfolio(near, assets), HTML);
  } catch (error) {
    console.error("Portfolio error:", error);
    await ctx.reply("❌ Portfolio is temporarily unavailable. Try again shortly.");
  }
}

export function registerBotHandlers(bot: Bot) {
  // A custodial trading bot must never act on messages in group chats.
  bot.chatType(["group", "supergroup", "channel"]).on("message", async (ctx) => {
    if (ctx.message.text?.startsWith("/")) {
      await ctx.reply("🔒 Neyro only works in a private chat.");
    }
  });

  const pm = bot.chatType("private");

  pm.command("start", async (ctx) => {
    await ctx.reply("⚡ Neyro\n\nNEAR trading terminal.\n\nChoose an action:", { reply_markup: mainMenu() });
  });

  pm.command("wallet", async (ctx) => {
    const telegramUserId = ctx.from.id;
    try {
      const existing = await walletService.getWallet(telegramUserId);
      if (existing) {
        const balance = await getNearBalance(existing.accountId);
        await ctx.reply(
          `👛 <b>Your Neyro wallet</b>\n\nNetwork: ${existing.network}\nAccount: ${code(existing.accountId)}\nBalance: ${renderBalance(balance)}\n\nUse /deposit to show the funding address.`,
          HTML
        );
        return;
      }
      const wallet = await walletService.createWallet(telegramUserId);
      await ctx.reply(
        `✅ <b>Wallet created</b>\n\nNetwork: ${wallet.network}\nAccount: ${code(wallet.accountId)}\n\nUse /deposit to fund this wallet.\n\n⚠️ This wallet is custodial. Do not deposit meaningful funds until recovery and operational safeguards are fully deployed.`,
        HTML
      );
    } catch (error) {
      console.error("Wallet error:", error);
      await ctx.reply(`❌ ${userMessage(error, "Wallet is temporarily unavailable")}`);
    }
  });

  pm.command("deposit", async (ctx) => {
    const wallet = await requireWallet(ctx);
    if (!wallet) return;
    await ctx.reply(
      `📥 <b>Deposit address</b>\n\nNetwork: ${wallet.network}\n${code(wallet.accountId)}\n\nSend NEAR first: it activates the account and pays for gas. Only send assets on NEAR ${wallet.network}.`,
      HTML
    );
  });

  pm.command("balance", async (ctx) => {
    const wallet = await requireWallet(ctx);
    if (!wallet) return;
    try {
      const balance = await getNearBalance(wallet.accountId);
      await ctx.reply(`💰 <b>NEAR balance</b>\n\n${renderBalance(balance)}\n\nWallet: ${code(wallet.accountId)}`, HTML);
    } catch (error) {
      console.error("Balance error:", error);
      await ctx.reply("❌ Balance is temporarily unavailable. Try again shortly.");
    }
  });

  pm.command("portfolio", showPortfolio);

  async function prepareTrade(ctx: Context, side: "buy" | "sell") {
    const userId = ctx.from?.id;
    if (!userId) return void await ctx.reply("❌ Telegram user identity is unavailable.");

    const parts = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      return void await ctx.reply(side === "buy"
        ? "⚡ Usage: /buy <token> <amount-near>"
        : "💰 Usage: /sell <token> <amount-token>");
    }

    try {
      const prepared = await tradingService.prepare(userId, side, parts[0]!, parts[1]!);
      const input = formatUnits(prepared.request.amountIn, prepared.request.tokenIn.decimals ?? 0);
      const output = formatUnits(prepared.quote.expectedOut, prepared.quote.tokenOut.decimals ?? 0);
      const minimum = formatUnits(prepared.quote.minAmountOut, prepared.quote.tokenOut.decimals ?? 0);
      const symbolIn = escapeHtml(prepared.request.tokenIn.symbol ?? prepared.request.tokenIn.address);
      const symbolOut = escapeHtml(prepared.request.tokenOut.symbol ?? prepared.request.tokenOut.address);
      const seconds = Math.max(0, Math.round((prepared.expiresAt - Date.now()) / 1000));

      await ctx.reply(
        "🔎 <b>Confirm trade</b>\n\n" +
        `Side: ${side.toUpperCase()}\n` +
        `You spend: ${input} ${symbolIn}\n` +
        `Expected: ${output} ${symbolOut}\n` +
        `Minimum: ${minimum} ${symbolOut}\n` +
        `Slippage: ${prepared.request.slippageBps / 100}%\n` +
        `Router: ${escapeHtml(prepared.quote.router ?? "RHEA")}\n\n` +
        (prepared.unlisted
          ? `⚠️ <b>Unlisted token.</b> ${code(side === "buy" ? prepared.request.tokenOut.address : prepared.request.tokenIn.address)} is not on RHEA's token list. Verify the contract; anyone can deploy a token with any symbol.\n\n`
          : "") +
        `Quote expires in ${seconds}s.`,
        {
          ...HTML,
          reply_markup: new InlineKeyboard()
            .text("✅ Confirm", `trade:confirm:${prepared.id}`)
            .text("❌ Cancel", `trade:cancel:${prepared.id}`)
        }
      );
    } catch (error) {
      console.error("Trade quote error:", error);
      await ctx.reply(`❌ ${userMessage(error, "Unable to create a quote right now")}`);
    }
  }

  pm.command("buy", async (ctx) => { await prepareTrade(ctx, "buy"); });
  pm.command("sell", async (ctx) => { await prepareTrade(ctx, "sell"); });

  pm.callbackQuery(/^trade:confirm:([a-f0-9]{16})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Executing trade…");
    await ctx.editMessageReplyMarkup();
    try {
      const result = await tradingService.execute(ctx.from.id, ctx.match[1]!);
      await ctx.editMessageText(renderExecution(result), HTML);
    } catch (error) {
      console.error("Trade execution error:", error);
      await ctx.editMessageText(`❌ ${userMessage(error, "Trade could not be executed")}`);
    }
  });

  pm.callbackQuery(/^trade:cancel:([a-f0-9]{16})$/, async (ctx) => {
    tradingService.cancel(ctx.from.id, ctx.match[1]!);
    await ctx.answerCallbackQuery("Trade cancelled");
    await ctx.editMessageText("❌ Trade cancelled.");
  });

  pm.callbackQuery(/^trade:(buy|sell)$/, async (ctx) => {
    const side = ctx.match[1];
    await ctx.answerCallbackQuery();
    await ctx.reply(side === "buy" ? "⚡ Buy\n\nSend: /buy <token> <amount-near>" : "💰 Sell\n\nSend: /sell <token> <amount-token>");
  });
  pm.callbackQuery("portfolio", async (ctx) => { await ctx.answerCallbackQuery(); await showPortfolio(ctx); });
  pm.callbackQuery("discover", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("🔎 Discover\n\nNEARly token discovery will be connected after core trading."); });
  pm.callbackQuery("wallet", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("👛 Wallet\n\nUse /wallet to create or view your Neyro wallet."); });
  pm.callbackQuery("settings", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("⚙️ Settings\n\nSlippage and trading limits will be configurable here."); });
}
