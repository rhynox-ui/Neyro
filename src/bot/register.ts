import type { Bot } from "grammy";
import { mainMenu } from "./menu.js";
import { WalletService } from "../wallet/service.js";

const walletService = new WalletService();

export function registerBotHandlers(bot: Bot) {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "⚡ Neyro\n\nNEAR trading terminal.\n\nChoose an action:",
      { reply_markup: mainMenu() }
    );
  });

  bot.command("wallet", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) {
      await ctx.reply("❌ Telegram user identity is unavailable.");
      return;
    }

    const existing = await walletService.getWallet(telegramUserId);
    if (existing) {
      await ctx.reply(
        `👛 Your Neyro wallet\n\nNetwork: ${existing.network}\nAccount: \`${existing.accountId}\`\n\nFund this account with NEAR to start trading.`
      );
      return;
    }

    try {
      const wallet = await walletService.createWallet(telegramUserId);
      await ctx.reply(
        `✅ Wallet created\n\nNetwork: ${wallet.network}\nAccount: \`${wallet.accountId}\`\n\nSend NEAR to this account to fund it.\n\n⚠️ Neyro's current wallet service is an early custodial implementation. Do not deposit meaningful funds until persistent encrypted storage and recovery are enabled.`
      );
    } catch (error) {
      console.error("Wallet creation error:", error);
      await ctx.reply("❌ Wallet creation is not configured yet.");
    }
  });

  bot.command("buy", async (ctx) => {
    await ctx.reply("⚡ Buy\n\nUsage in MVP: /buy <token> <amount-near>");
  });

  bot.command("sell", async (ctx) => {
    await ctx.reply("💰 Sell\n\nUsage in MVP: /sell <token> <amount-token>");
  });

  bot.callbackQuery(/^trade:(buy|sell)$/, async (ctx) => {
    const side = ctx.match[1];
    await ctx.answerCallbackQuery();
    await ctx.reply(side === "buy"
      ? "⚡ Buy\n\nSend: /buy <token> <amount-near>"
      : "💰 Sell\n\nSend: /sell <token> <amount-token>");
  });

  bot.callbackQuery("portfolio", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("💼 Portfolio\n\nPortfolio tracking is coming in the wallet milestone.");
  });

  bot.callbackQuery("discover", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("🔎 Discover\n\nNEARly token discovery will be connected after core trading.");
  });

  bot.callbackQuery("wallet", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("👛 Wallet\n\nUse /wallet to create or view your Neyro wallet.");
  });

  bot.callbackQuery("settings", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("⚙️ Settings\n\nSlippage and trading limits will be configurable here.");
  });
}
