import { Bot } from "grammy";
import { withRpcFallback } from "../near/rpc.js";
import { registerBotHandlers } from "./register.js";
import { rateLimit } from "./rate-limit.js";

export const BOT_COMMANDS = [
  { command: "start", description: "Open the Neyro trading terminal" },
  { command: "help", description: "Show all Neyro commands" },
  { command: "wallet", description: "Create or view your wallet" },
  { command: "deposit", description: "Show your deposit address" },
  { command: "balance", description: "NEAR balance" },
  { command: "portfolio", description: "Token holdings" },
  { command: "new", description: "Newest NEARly launches" },
  { command: "launch", description: "Launch a token on NEARly" },
  { command: "launch-status", description: "Check a pending NEARly launch" },
  { command: "launch-history", description: "View your previous NEARly launches" },
  { command: "launch-cancel", description: "Cancel an unfinished launch wizard" },
  { command: "withdraw", description: "Send NEAR or tokens out: /withdraw <amount|all> <token> <to>" },
  { command: "rhea-register", description: "Register a token for RHEA swaps" },
  { command: "rhea-recovery", description: "Check RHEA internal balances" },
  { command: "rhea-withdraw", description: "Recover an RHEA internal balance" },
  { command: "buy", description: "Buy a token with NEAR: /buy <token> <amount>" },
  { command: "sell", description: "Sell a token for NEAR: /sell <token> <amount|all>" },
  { command: "settings", description: "View and change trading settings" },
  { command: "health", description: "Bot and NEAR RPC status" }
];

/** The bot with every handler registered; shared by the Node and Worker entry points. */
export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.use(rateLimit);
  registerBotHandlers(bot);

  bot.command("health", async (ctx) => {
    const status = await withRpcFallback(async (provider) =>
      provider.sendJsonRpc("status", {}) as Promise<{ sync_info: { latest_block_height: number } }>
    );
    await ctx.reply(`🟢 Neyro online\nNEAR block: ${status.sync_info.latest_block_height}`);
  });

  bot.catch((error) => {
    console.error("Telegram error:", error);
  });

  return bot;
}
