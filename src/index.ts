import { Bot } from "grammy";
import { config } from "./config.js";
import { createNearConnection } from "./near/client.js";

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

bot.command("start", async (ctx) => {
  await ctx.reply(
    "⚡ Neyro\n\nNEAR trading terminal.\n\nWallet and trading modules are being initialized."
  );
});

bot.command("health", async (ctx) => {
  const near = await createNearConnection();
  const status = await near.connection.provider.status();
  await ctx.reply(
    `🟢 Neyro online\nNEAR: ${status.sync_info.latest_block_height}`
  );
});

bot.catch((error) => {
  console.error("Telegram error:", error);
});

console.log("Neyro starting...");
await bot.start();
