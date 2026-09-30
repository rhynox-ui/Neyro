import { Bot } from "grammy";
import { withRpcFallback } from "../near/rpc.js";
import { registerBotHandlers } from "./register.js";
import { rateLimit } from "./rate-limit.js";
import { BOT_COMMANDS } from "./commands.js";

export { BOT_COMMANDS } from "./commands.js";

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
