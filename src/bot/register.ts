import type { Bot } from "grammy";
import { mainMenu } from "./menu.js";

export function registerBotHandlers(bot: Bot) {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "⚡ Neyro\n\nNEAR trading terminal.\n\nChoose an action:",
      { reply_markup: mainMenu() }
    );
  });

  bot.command("wallet", async (ctx) => {
    await ctx.reply(
      "👛 Wallet\n\nWallet management is the next milestone.\nYour signer will be isolated from the Telegram layer."
    );
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
    await ctx.reply("👛 Wallet\n\nWallet creation and secure signing are the next milestone.");
  });

  bot.callbackQuery("settings", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("⚙️ Settings\n\nSlippage and trading limits will be configurable here.");
  });
}
