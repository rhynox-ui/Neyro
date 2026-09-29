import { Bot } from "grammy";
import { config } from "./config.js";
import { createNearConnection } from "./near/client.js";
import { registerBotHandlers, reconcileTradingState } from "./bot/register.js";

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

registerBotHandlers(bot);

await reconcileTradingState();

bot.command("health", async (ctx) => {
  const near = createNearConnection();
  const status = await near.provider.sendJsonRpc("status", {}) as {
    sync_info: { latest_block_height: number };
  };

  await ctx.reply(
    `🟢 Neyro online\nNEAR block: ${status.sync_info.latest_block_height}`
  );
});

bot.catch((error) => {
  console.error("Telegram error:", error);
});

console.log("Neyro starting...");
await bot.start();
