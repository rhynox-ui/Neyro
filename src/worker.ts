// Cloudflare Workers entry point: Telegram webhook, optional Queue consumer,
// and a cron trigger for the trade reconciler. src/index.ts is the Node
// (long polling) equivalent.
import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import { BOT_COMMANDS } from "./bot/commands.js";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface UpdateQueue {
  send(message: unknown): Promise<unknown>;
}

interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  SETUP_SECRET?: string;
  NEYRO_TELEGRAM_UPDATES?: UpdateQueue;
}

type QueueBatch = {
  messages: readonly { body: Update; ack(): void }[];
};

const REQUIRED_SECRETS = ["TELEGRAM_BOT_TOKEN", "DATABASE_URL", "NEYRO_MASTER_KEY"] as const;

function missingSecrets(): string[] {
  return REQUIRED_SECRETS.filter((name) => !process.env[name]);
}

type App = Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  const [configModule, create, register, repository, reconciler, execution, rpc, dex, dcl, nearly, rhea, ft, icon, tokens, autodelete, pools, onchain, store] = await Promise.all([
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
    import("./bot/autodelete.js"),
    import("./market/pools.js"),
    import("./market/onchain.js"),
    import("./state/store.js")
  ]);
  return { config: configModule.config, create, register, repository, reconciler, execution, rpc, dex, dcl, nearly, rhea, ft, icon, tokens, autodelete, pools, onchain, store };
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

function getBot(): Promise<Bot> {
  botPromise ??= (async () => {
    const app = await getApp();
    const bot = app.create.createBot(app.config.TELEGRAM_BOT_TOKEN);
    await bot.init();
    await bot.api.setMyCommands(app.create.BOT_COMMANDS);
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
  if (app.config.NEAR_NETWORK !== "mainnet") return "The Worker only runs on NEAR mainnet";
  return undefined;
}

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Neyro webhook is up.");

  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

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

async function telegramApi(env: Env, method: string, body: unknown): Promise<{ ok: boolean; description?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as { ok: boolean; description?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram ${method} failed: ${payload.description ?? `HTTP ${response.status}`}`);
  }
  return payload;
}

/**
 * Webhook setup intentionally does not load the application/database stack.
 * It only authenticates the setup secret and talks directly to Telegram using
 * Worker bindings. This keeps deployment recovery independent of app config.
 */
async function handleSetup(request: Request, env: Env): Promise<Response> {
  if (!env.SETUP_SECRET || request.headers.get("x-neyro-setup-secret") !== env.SETUP_SECRET) {
    return new Response("Unauthorized. Provide the X-Neyro-Setup-Secret header.", { status: 401 });
  }
  if (!env.TELEGRAM_BOT_TOKEN) {
    return new Response("TELEGRAM_BOT_TOKEN is not configured.", { status: 500 });
  }

  const url = new URL(request.url);
  const webhookUrl = `${url.origin}/webhook`;

  try {
    await telegramApi(env, "setWebhook", {
      url: webhookUrl,
      ...(env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: env.TELEGRAM_WEBHOOK_SECRET } : {}),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false
    });
    await telegramApi(env, "setMyCommands", { commands: BOT_COMMANDS });
    return Response.json({ ok: true, webhookUrl, commands: BOT_COMMANDS.length });
  } catch (error) {
    console.error("Webhook setup failed:", error);
    return new Response("Telegram webhook setup failed.", { status: 502 });
  }
}

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

async function handleDebugPrice(request: Request): Promise<Response> {
  const app = await getApp();
  const url = new URL(request.url);
  if (!app.config.SETUP_SECRET || request.headers.get("x-neyro-setup-secret") !== app.config.SETUP_SECRET) {
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
  const probe = (target: string) => step(async () => {
    const response = await fetch(target, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; NeyroBot/1.0)" } });
    return { status: response.status, body: (await response.text()).slice(0, 400) };
  });
  const sources = {
    intear: await probe(`https://prices.intear.tech/token?token_id=${encodeURIComponent(token)}`),
    geckoterminal: await probe(`https://api.geckoterminal.com/api/v2/networks/near/tokens/${encodeURIComponent(token)}/pools?page=1`)
  };
  const poolIndex = await step(async () => {
    const cursor = await app.pools.loadPoolCursor();
    return { ...cursor, entries: await app.pools.defaultPoolStore().count() };
  });
  const tokenPools = await step(() => app.pools.poolsForToken(token));
  const onchain = await step(async () => {
    const tokens = await new app.rhea.RheaClient().getNearTokens().catch(() => []);
    const pricer = app.onchain.buildQuotePricer(tokens, typeof nearUsd === "number" ? nearUsd : null);
    return app.onchain.onchainMarket(token, pricer);
  });
  const iconCheck = await step(async () => {
    const metadata = await app.ft.ftMetadata(token);
    const source = app.icon.decodeIcon(metadata.icon);
    return source ? (source.kind === "image" ? `${source.contentType}, ${source.bytes.length} bytes` : `redirect ${source.url}`) : `no usable icon (${metadata.icon ? metadata.icon.slice(0, 30) : "none"})`;
  });
  return Response.json({ token, icon: iconCheck, sources, fastnearKey: Boolean(app.config.FASTNEAR_API_KEY), rpc, rheaNear, dclNear, dexscreener, poolIndex, tokenPools, onchain, launch: launchValue ? { poolId: launchValue.poolId, tokenIsX: launchValue.tokenIsX, quote: launchValue.quote } : launch, pool, pricing });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Recovery endpoints must be reachable even if the application stack has
    // a configuration/runtime problem.
    if (url.pathname === "/setup-webhook") return handleSetup(request, env);
    if (url.pathname === "/health") {
      const problem = await configurationProblem();
      return Response.json({
        ok: !problem,
        ...(problem ? { problem } : {}),
        network: process.env.NEAR_NETWORK,
        fastnearKey: Boolean(process.env.FASTNEAR_API_KEY),
        coingeckoKey: Boolean(process.env.COINGECKO_API_KEY),
        queue: Boolean(env.NEYRO_TELEGRAM_UPDATES)
      });
    }

    const problem = await configurationProblem();
    if (problem) return new Response(problem, { status: 500 });
    if (url.pathname === "/webhook") return handleWebhook(request, env, ctx);
    if (url.pathname === "/debug/price") return handleDebugPrice(request);
    if (url.pathname.startsWith("/icon/")) return handleIcon(url.pathname);
    return new Response("Neyro is running.");
  },

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

  async scheduled(_event: unknown, _env: Env, ctx: ExecutionContext): Promise<void> {
    if (await configurationProblem()) return;
    const app = await getApp();
    const databaseUrl = app.config.DATABASE_URL!;
    const bot = await getBot();
    ctx.waitUntil(app.autodelete.deleteDueMessages(bot.api).catch((error) => console.error("Message cleanup failed:", error)));
    ctx.waitUntil(app.store.defaultStateStore().purgeExpired().catch((error) => console.error("State purge failed:", error)));
    ctx.waitUntil(app.pools.refreshPoolIndex().catch((error) => console.error("Pool index refresh failed:", error)));
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
