import { Bot } from "grammy";
import { config } from "./config.js";
import { createNearConnection } from "./near/client.js";
import { registerBotHandlers } from "./bot/register.js";

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

registerBotHandlers(bot);

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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void bot.stop());
}

await bot.api.setMyCommands([
  { command: "wallet", description: "Create or view your wallet" },
  { command: "deposit", description: "Show your deposit address" },
  { command: "balance", description: "NEAR balance" },
  { command: "portfolio", description: "Token holdings" },
  { command: "buy", description: "Buy a token with NEAR: /buy <token> <amount>" },
  { command: "sell", description: "Sell a token for NEAR: /sell <token> <amount>" },
  { command: "health", description: "Bot and NEAR RPC status" }
]).catch((error) => console.warn("Could not register bot commands:", error));

console.log("Neyro starting...");
await bot.start();
