// Cloudflare Workers entry point: Telegram webhook, optional Queue consumer,
// and a cron trigger for the trade reconciler. src/index.ts is the Node
// (long polling) equivalent.
//
// Nothing that reads configuration is imported at module level. Cloudflare
// runs the module's top level once while validating an upload, before any
// secrets exist on a first deploy; a config error there would block the
// deploy. The app loads on the first request instead, and /health reports
// what is missing.
import type { Bot } from "grammy";
import type { Update } from "grammy/types";

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

/** Secrets set with `wrangler secret put`; checked by name only, never logged. */
const REQUIRED_SECRETS = ["TELEGRAM_BOT_TOKEN", "DATABASE_URL", "NEYRO_MASTER_KEY"] as const;

function missingSecrets(): string[] {
  return REQUIRED_SECRETS.filter((name) => !process.env[name]);
}

type App = Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  const [configModule, create, register, repository, reconciler, execution, rpc, dex, dcl, nearly, rhea, ft, icon, tokens, autodelete] = await Promise.all([
    import("./config.js"),
    import("./bot/create.js"),
    import("./bot/register.js"),
    import("./trading/repository.js"),
    import("./trading/reconciler.js"),
    import("./near/execution.js"),
    import("./near/rpc.js"),
    import("./market/dexscreener.js"),
    import("./market/dcl.js"),
    import("./discovery/nearly.js"),
    import("./rhea/client.js"),
    import("./near/ft.js"),
    import("./market/icon.js"),
    import("./near/tokens.js"),
    import("./bot/autodelete.js")
  ]);
  return { config: configModule.config, create, register, repository, reconciler, execution, rpc, dex, dcl, nearly, rhea, ft, icon, tokens, autodelete };
}

let appPromise: Promise<App> | undefined;
let botPromise: Promise<Bot> | undefined;

function getApp(): Promise<App> {
  appPromise ??= loadModules().catch((error) => {
    appPromise = undefined;
    throw error;
  });
  return appPromise;
}

/** One bot per isolate; init() fetches the bot's own info once. */
function getBot(): Promise<Bot> {
  botPromise ??= (async () => {
    const app = await getApp();
    const bot = app.create.createBot(app.config.TELEGRAM_BOT_TOKEN);
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

/** Why the Worker can't serve yet, or undefined when it can. */
async function configurationProblem(): Promise<string | undefined> {
  const missing = missingSecrets();
  if (missing.length) return `Missing secrets: ${missing.join(", ")}`;
  let app: App;
  try {
    app = await getApp();
  } catch (error) {
    const issues = (error as { issues?: { path?: unknown[]; message?: string }[] }).issues;
    return issues
      ? `Invalid configuration: ${issues.map((issue) => `${issue.path?.join(".")}: ${issue.message}`).join("; ")}`
      : "Configuration failed to load";
  }
  // The deployed bot is mainnet-only.
  if (app.config.NEAR_NETWORK !== "mainnet") return "The Worker only runs on NEAR mainnet";
  return undefined;
}

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Neyro webhook is up.");

  const { config } = await getApp();
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
  const { config, create } = await getApp();
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
  await bot.api.setMyCommands(create.BOT_COMMANDS);
  return Response.json({ ok: true, webhookUrl, commands: create.BOT_COMMANDS.length });
}

/** GET /icon/<token>: the token's on-chain icon, for Telegram link previews. */
async function handleIcon(pathname: string): Promise<Response> {
  const app = await getApp();
  const token = decodeURIComponent(pathname.slice("/icon/".length)).toLowerCase();
  if (!app.tokens.isValidAccountId(token)) return new Response("Bad token", { status: 400 });
  const metadata = await app.ft.ftMetadata(token).catch(() => null);
  const source = app.icon.decodeIcon(metadata?.icon);
  if (!source) return new Response("No icon", { status: 404 });
  if (source.kind === "redirect") return Response.redirect(source.url, 302);
  return new Response(source.bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": source.contentType,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

/**
 * GET /debug/price?secret=SETUP_SECRET&token=<contract>: runs each market-data
 * step for one token and reports its result or error, for diagnosing blank
 * token cards. Returns only public market data.
 */
async function handleDebugPrice(request: Request): Promise<Response> {
  const app = await getApp();
  const url = new URL(request.url);
  if (!app.config.SETUP_SECRET || url.searchParams.get("secret") !== app.config.SETUP_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  const token = (url.searchParams.get("token") ?? "").trim().toLowerCase();
  const step = async (run: () => Promise<unknown>) => {
    const started = Date.now();
    try {
      return { ok: true, ms: Date.now() - started, value: await run() };
    } catch (error) {
      return { ok: false, ms: Date.now() - started, error: String(error).slice(0, 300) };
    }
  };

  // Each RPC endpoint on its own, so a rate-limited one is visible.
  const rpc = Object.fromEntries(await Promise.all(app.rpc.RPC_ENDPOINTS.map(async (endpoint) => [
    endpoint.name,
    { url: endpoint.url, ...(await step(async () => {
      const view = await app.rpc.createRpcProvider(endpoint.url).viewAccount({ accountId: "wrap.near" });
      return `ok (storage ${view.storage_usage} bytes)`;
    })) }
  ])));
  const rheaNear = await step(async () => {
    const tokens = await new app.rhea.RheaClient().getNearTokens();
    const near = tokens.find(app.rhea.isNearNative);
    return near ? { address: near.address, isNative: near.isNative, price: near.price } : `NEAR not in list (${tokens.length} tokens)`;
  });
  const dclNear = await step(() => app.dcl.nearUsdFromDcl());
  const dexscreener = await step(async () => {
    const market = await app.dex.fetchNearMarket(token);
    return market ? { priceUsd: market.priceUsd, liquidityUsd: market.liquidityUsd, cachedAtMs: market.cachedAtMs ?? null } : null;
  });
  const launch = await step(() => app.nearly.fetchLaunchByToken(token));
  const launchValue = launch.ok ? (launch as { value: Awaited<ReturnType<typeof app.nearly.fetchLaunchByToken>> }).value : null;
  const pool = launchValue?.poolId
    ? await step(async () => {
        const result = await app.dcl.fetchDclPool(launchValue.poolId!);
        return result ? { currentPoint: result.currentPoint, totalX: String(result.totalX), totalY: String(result.totalY) } : null;
      })
    : { ok: false, error: "no pool id on launch" };
  const nearUsd = (dclNear as { value?: unknown }).value;
  const pricing = launchValue
    ? await step(() => app.nearly.nearlyPriceUsd(launchValue, typeof nearUsd === "number" ? nearUsd : null))
    : { ok: false, error: "no launch" };

  // Candidate sources for 24h stats, fetched from the Worker's own IP.
  const probe = (target: string) => step(async () => {
    const response = await fetch(target, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; NeyroBot/1.0)" } });
    return { status: response.status, body: (await response.text()).slice(0, 400) };
  });
  const sources = {
    intear: await probe(`https://prices.intear.tech/token?token_id=${encodeURIComponent(token)}`),
    geckoterminal: await probe(`https://api.geckoterminal.com/api/v2/networks/near/tokens/${encodeURIComponent(token)}/pools?page=1`)
  };
  const iconCheck = await step(async () => {
    const metadata = await app.ft.ftMetadata(token);
    const source = app.icon.decodeIcon(metadata.icon);
    return source ? (source.kind === "image" ? `${source.contentType}, ${source.bytes.length} bytes` : `redirect ${source.url}`) : `no usable icon (${metadata.icon ? metadata.icon.slice(0, 30) : "none"})`;
  });

  return Response.json({ token, icon: iconCheck, sources, fastnearKey: Boolean(app.config.FASTNEAR_API_KEY), rpc, rheaNear, dclNear, dexscreener, launch: launchValue ? { poolId: launchValue.poolId, tokenIsX: launchValue.tokenIsX, quote: launchValue.quote } : launch, pool, pricing });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const problem = await configurationProblem();

    if (url.pathname === "/health") {
      return Response.json({
        ok: !problem,
        ...(problem ? { problem } : {}),
        network: process.env.NEAR_NETWORK,
        fastnearKey: Boolean(process.env.FASTNEAR_API_KEY),
        coingeckoKey: Boolean(process.env.COINGECKO_API_KEY),
        queue: Boolean(env.NEYRO_TELEGRAM_UPDATES)
      });
    }
    if (problem) return new Response(problem, { status: 500 });
    if (url.pathname === "/webhook") return handleWebhook(request, env, ctx);
    if (url.pathname === "/setup-webhook") return handleSetup(request);
    if (url.pathname === "/debug/price") return handleDebugPrice(request);
    if (url.pathname.startsWith("/icon/")) return handleIcon(url.pathname);
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

  /** Cron trigger (every minute): delete expired key messages, settle unknown or stale trades. */
  async scheduled(_event: unknown, _env: Env, ctx: ExecutionContext): Promise<void> {
    if (await configurationProblem()) return;
    const app = await getApp();
    const databaseUrl = app.config.DATABASE_URL!;
    const bot = await getBot();
    ctx.waitUntil(app.autodelete.deleteDueMessages(bot.api).catch((error) => console.error("Message cleanup failed:", error)));
    ctx.waitUntil(app.reconciler.reconcileOnce({
      repository: new app.repository.PostgresTradeRepository(databaseUrl),
      lookup: (txHash, accountId) =>
        app.rpc.withRpcFallback((provider) => app.execution.lookupTransaction(provider, txHash, accountId)),
      notify: async (telegramUserId, text) => {
        await bot.api.sendMessage(telegramUserId, text, { link_preview_options: { is_disabled: true } });
      },
      explorerLink: app.register.explorerTx
    }).catch((error) => console.error("Reconciler pass failed:", error)));
  }
};
