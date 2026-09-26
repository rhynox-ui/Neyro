import { Bot } from "grammy";
import { createNearConnection } from "../near/client.js";
import { registerBotHandlers } from "./register.js";

export const BOT_COMMANDS = [
  { command: "wallet", description: "Create or view your wallet" },
  { command: "deposit", description: "Show your deposit address" },
  { command: "balance", description: "NEAR balance" },
  { command: "portfolio", description: "Token holdings" },
  { command: "new", description: "Newest NEARly launches" },
  { command: "withdraw", description: "Send NEAR or tokens out: /withdraw <amount|all> <token> <to>" },
  { command: "buy", description: "Buy a token with NEAR: /buy <token> <amount>" },
  { command: "sell", description: "Sell a token for NEAR: /sell <token> <amount>" },
  { command: "settings", description: "Default slippage" },
  { command: "health", description: "Bot and NEAR RPC status" }
];

/** The bot with every handler registered; shared by the Node and Worker entry points. */
export function createBot(token: string): Bot {
  const bot = new Bot(token);

  registerBotHandlers(bot);

  bot.command("health", async (ctx) => {
    const near = createNearConnection();
    const status = await near.provider.sendJsonRpc("status", {}) as {
      sync_info: { latest_block_height: number };
    };
    await ctx.reply(`🟢 Neyro online\nNEAR block: ${status.sync_info.latest_block_height}`);
  });

  bot.catch((error) => {
    console.error("Telegram error:", error);
  });

  return bot;
}
