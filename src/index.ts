// Node entry point: long polling. On Cloudflare Workers, src/worker.ts is
// used instead (webhook + cron).
import "dotenv/config";
import { config } from "./config.js";
import { BOT_COMMANDS, createBot } from "./bot/create.js";
import { explorerTx } from "./bot/register.js";
import { deleteDueMessages } from "./bot/autodelete.js";
import { PostgresTradeRepository } from "./trading/repository.js";
import { startReconciler } from "./trading/reconciler.js";
import { lookupTransaction } from "./near/execution.js";
import { withRpcFallback } from "./near/rpc.js";

const bot = createBot(config.TELEGRAM_BOT_TOKEN);

// Settles trades whose outcome was unknown at execution time (RPC timeout,
// crash mid-trade) and tells the user. Needs the database's tx journal.
const stopReconciler = config.DATABASE_URL
  ? startReconciler({
      repository: new PostgresTradeRepository(config.DATABASE_URL),
      lookup: (txHash, accountId) =>
        withRpcFallback((provider) => lookupTransaction(provider, txHash, accountId)),
      notify: async (telegramUserId, text) => {
        await bot.api.sendMessage(telegramUserId, text, { link_preview_options: { is_disabled: true } });
      },
      explorerLink: explorerTx
    })
  : () => {};

// Deletes exported-key messages when their time is up.
const cleanup = setInterval(() => {
  deleteDueMessages(bot.api).catch((error) => console.error("Message cleanup failed:", error));
}, 15_000);
cleanup.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(cleanup);
    stopReconciler();
    void bot.stop();
  });
}

await bot.api.setMyCommands(BOT_COMMANDS)
  .catch((error) => console.warn("Could not register bot commands:", error));

console.log("Neyro starting...");
await bot.start();
