import { InlineKeyboard, type Bot, type CommandContext } from "grammy";
import { mainMenu } from "./menu.js";
import { WalletService } from "../wallet/service.js";
import { getNearBalance } from "../near/account.js";
import { formatUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { TradingService } from "../trading/service.js";

const walletService = new WalletService();
const tradingService = new TradingService(walletService);

export function registerBotHandlers(bot: Bot) {
  bot.command("start", async (ctx) => {
    await ctx.reply("⚡ Neyro\n\nNEAR trading terminal.\n\nChoose an action:", { reply_markup: mainMenu() });
  });

  bot.command("wallet", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return void await ctx.reply("❌ Telegram user identity is unavailable.");
    const existing = await walletService.getWallet(telegramUserId);
    if (existing) {
      const balance = await getNearBalance(existing.accountId);
      await ctx.reply(`👛 Your Neyro wallet\n\nNetwork: ${existing.network}\nAccount: \`${existing.accountId}\`\nBalance: ${balance} yoctoNEAR\n\nUse /deposit to show the funding address.`);
      return;
    }
    try {
      const wallet = await walletService.createWallet(telegramUserId);
      await ctx.reply(`✅ Wallet created\n\nNetwork: ${wallet.network}\nAccount: \`${wallet.accountId}\`\n\nUse /deposit to fund this wallet.\n\n⚠️ Current wallet service is custodial. Do not deposit meaningful funds until persistent encrypted storage, recovery, and operational safeguards are fully deployed.`);
    } catch (error) {
      console.error("Wallet creation error:", error);
      await ctx.reply("❌ Wallet creation is not configured yet.");
    }
  });

  bot.command("deposit", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return void await ctx.reply("❌ Telegram user identity is unavailable.");
    const wallet = await walletService.getWallet(telegramUserId);
    if (!wallet) return void await ctx.reply("👛 No wallet yet. Use /wallet to create one.");
    await ctx.reply(`📥 Deposit address\n\nNetwork: ${wallet.network}\n\`${wallet.accountId}\`\n\nOnly send assets supported by Neyro on the selected network.`);
  });

  bot.command("balance", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return void await ctx.reply("❌ Telegram user identity is unavailable.");
    const wallet = await walletService.getWallet(telegramUserId);
    if (!wallet) return void await ctx.reply("👛 No wallet yet. Use /wallet to create one.");
    const balance = await getNearBalance(wallet.accountId);
    await ctx.reply(`💰 NEAR balance\n\n${balance} yoctoNEAR\n\nWallet: \`${wallet.accountId}\``);
  });

  async function prepareTrade(ctx: CommandContext, side: "buy" | "sell") {
    const userId = ctx.from?.id;
    if (!userId) return void await ctx.reply("❌ Telegram user identity is unavailable.");

    const parts = String(ctx.match ?? "").trim().split(/\\s+/).filter(Boolean);
    if (parts.length !== 2) {
      return void await ctx.reply(side === "buy"
        ? "⚡ Usage: /buy <token> <amount-near>"
        : "💰 Usage: /sell <token> <amount-token>");
    }

    try {
      const prepared = await tradingService.prepare(userId, side, parts[0], parts[1]);
      const input = formatUnits(prepared.request.amountIn, prepared.request.tokenIn.decimals);
      const output = formatUnits(prepared.quote.expectedOut, prepared.quote.tokenOut.decimals);
      const minimum = formatUnits(prepared.quote.minAmountOut, prepared.quote.tokenOut.decimals);
      const symbolIn = prepared.request.tokenIn.symbol ?? prepared.request.tokenIn.address;
      const symbolOut = prepared.request.tokenOut.symbol ?? prepared.request.tokenOut.address;

      await ctx.reply(
        "🔎 Confirm trade\n\n" +
        `Side: ${side.toUpperCase()}\n` +
        `You spend: ${input} ${symbolIn}\n` +
        `Expected: ${output} ${symbolOut}\n` +
        `Minimum: ${minimum} ${symbolOut}\n` +
        `Slippage: ${prepared.request.slippageBps / 100}%\n` +
        `Router: ${prepared.quote.router ?? "RHEA"}\n\n` +
        "Quote expires in about 2 minutes.",
        { reply_markup: new InlineKeyboard()
          .text("✅ Confirm", `trade:confirm:${prepared.id}`)
          .text("❌ Cancel", `trade:cancel:${prepared.id}`) }
      );
    } catch (error) {
      console.error("Trade quote error:", error);
      await ctx.reply(`❌ ${error instanceof Error ? error.message : "Unable to create quote"}`);
    }
  }

  bot.command("buy", async (ctx) => { await prepareTrade(ctx, "buy"); });
  bot.command("sell", async (ctx) => { await prepareTrade(ctx, "sell"); });

  bot.callbackQuery(/^trade:confirm:([a-f0-9]{16})$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return void await ctx.answerCallbackQuery("Telegram identity unavailable");
    await ctx.answerCallbackQuery("Executing trade…");
    try {
      const result = await tradingService.execute(userId, ctx.match[1]);
      await ctx.editMessageText(`✅ Trade submitted\n\nTransaction: ${result.transactionHash}`);
    } catch (error) {
      console.error("Trade execution error:", error);
      await ctx.editMessageText(`❌ Trade failed\n\n${error instanceof Error ? error.message : "Unknown execution error"}`);
    }
  });

  bot.callbackQuery(/^trade:cancel:([a-f0-9]{16})$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return void await ctx.answerCallbackQuery("Telegram identity unavailable");
    tradingService.cancel(userId, ctx.match[1]);
    await ctx.answerCallbackQuery("Trade cancelled");
    await ctx.editMessageText("❌ Trade cancelled.");
  });
  bot.callbackQuery(/^trade:(buy|sell)$/, async (ctx) => {
    const side = ctx.match[1];
    await ctx.answerCallbackQuery();
    await ctx.reply(side === "buy" ? "⚡ Buy\n\nSend: /buy <token> <amount-near>" : "💰 Sell\n\nSend: /sell <token> <amount-token>");
  });
  bot.callbackQuery("portfolio", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("💼 Portfolio\n\nPortfolio tracking is coming in the wallet milestone."); });
  bot.callbackQuery("discover", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("🔎 Discover\n\nNEARly token discovery will be connected after core trading."); });
  bot.callbackQuery("wallet", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("👛 Wallet\n\nUse /wallet to create or view your Neyro wallet."); });
  bot.callbackQuery("settings", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("⚙️ Settings\n\nSlippage and trading limits will be configurable here."); });
}