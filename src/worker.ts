// Cloudflare Workers entry point: Telegram webhook, optional Queue consumer,
// and a cron trigger for the trade reconciler. src/index.ts is the Node
// (long polling) equivalent.
import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import { config } from "./config.js";
import { BOT_COMMANDS, createBot } from "./bot/create.js";
import { explorerTx } from "./bot/register.js";
import { PostgresTradeRepository } from "./trading/repository.js";
import { reconcileOnce } from "./trading/reconciler.js";
import { lookupTransaction } from "./near/execution.js";
import { withRpcFallback } from "./near/rpc.js";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface UpdateQueue {
  send(message: unknown): Promise<unknown>;
}

interface Env {
  /** Optional Cloudflare Queue binding; see wrangler.jsonc. */
  NEYRO_TELEGRAM_UPDATES?: UpdateQueue;
}

type QueueBatch = {
  messages: readonly { body: Update; ack(): void }[];
};

let botPromise: Promise<Bot> | undefined;

/** One bot per isolate; init() fetches the bot's own info once. */
function getBot(): Promise<Bot> {
  botPromise ??= (async () => {
    const bot = createBot(config.TELEGRAM_BOT_TOKEN);
    await bot.init();
    return bot;
  })().catch((error) => {
    botPromise = undefined;
    throw error;
  });
  return botPromise;
}

async function processUpdate(update: Update): Promise<void> {
  const bot = await getBot();
  await bot.handleUpdate(update);
}

function configurationError(): string | undefined {
  // Each update can run in a different isolate, so wallets, quotes and
  // panels must live in the database; in-memory fallbacks would lose keys.
  return config.DATABASE_URL ? undefined : "DATABASE_URL is required on Cloudflare Workers";
}

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Neyro webhook is up.");

  const secret = config.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // With a Queue, the update is stored before acknowledging and processed
  // by the consumer with no time limit. Without one, it runs after the
  // response via waitUntil (about 30s guaranteed); a trade cut off mid-way
  // stays "executing" and the cron reconciler settles it from its tx journal.
  if (env.NEYRO_TELEGRAM_UPDATES) {
    try {
      await env.NEYRO_TELEGRAM_UPDATES.send(update);
    } catch (error) {
      console.error("Failed to enqueue Telegram update:", error);
      return new Response("Queue unavailable", { status: 503 });
    }
  } else {
    ctx.waitUntil(processUpdate(update).catch((error) => console.error("Update failed:", error)));
  }
  return new Response("ok");
}

/** GET /setup-webhook?secret=SETUP_SECRET points Telegram at this Worker. */
async function handleSetup(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!config.SETUP_SECRET || url.searchParams.get("secret") !== config.SETUP_SECRET) {
    return new Response("Unauthorized. Set SETUP_SECRET and pass ?secret=<SETUP_SECRET>.", { status: 401 });
  }

  const bot = await getBot();
  const webhookUrl = `${url.origin}/webhook`;
  await bot.api.setWebhook(webhookUrl, {
    ...(config.TELEGRAM_WEBHOOK_SECRET ? { secret_token: config.TELEGRAM_WEBHOOK_SECRET } : {}),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  });
  await bot.api.setMyCommands(BOT_COMMANDS);
  return Response.json({ ok: true, webhookUrl, commands: BOT_COMMANDS.length });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const problem = configurationError();

    if (url.pathname === "/health") {
      return Response.json({ ok: !problem, problem, network: config.NEAR_NETWORK, queue: Boolean(env.NEYRO_TELEGRAM_UPDATES) });
    }
    if (problem) return new Response(problem, { status: 500 });
    if (url.pathname === "/webhook") return handleWebhook(request, env, ctx);
    if (url.pathname === "/setup-webhook") return handleSetup(request);
    return new Response("Neyro is running.");
  },

  /**
   * Queue consumer. Every message is acknowledged, even on failure: retrying
   * an update could repeat a non-idempotent action such as a withdrawal.
   * Trades are protected by the database claim either way.
   */
  async queue(batch: QueueBatch): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processUpdate(message.body);
      } catch (error) {
        console.error("Queued update failed:", { updateId: message.body.update_id, error });
      }
      message.ack();
    }
  },

  /** Cron trigger (every minute): settle unknown or stale trades. */
  async scheduled(_event: unknown, _env: Env, ctx: ExecutionContext): Promise<void> {
    if (!config.DATABASE_URL) return;
    const bot = await getBot();
    ctx.waitUntil(reconcileOnce({
      repository: new PostgresTradeRepository(config.DATABASE_URL),
      lookup: (txHash, accountId) =>
        withRpcFallback((provider) => lookupTransaction(provider, txHash, accountId)),
      notify: async (telegramUserId, text) => {
        await bot.api.sendMessage(telegramUserId, text, { link_preview_options: { is_disabled: true } });
      },
      explorerLink: explorerTx
    }).catch((error) => console.error("Reconciler pass failed:", error)));
  }
};
