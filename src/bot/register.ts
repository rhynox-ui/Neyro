import type { Bot } from "grammy";
import { mainMenu } from "./menu.js";
import { WalletService } from "../wallet/service.js";
import { getNearBalance } from "../near/account.js";

const walletService = new WalletService();

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

  bot.command("buy", async (ctx) => { await ctx.reply("⚡ Buy\n\nUsage in MVP: /buy <token> <amount-near>"); });
  bot.command("sell", async (ctx) => { await ctx.reply("💰 Sell\n\nUsage in MVP: /sell <token> <amount-token>"); });
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