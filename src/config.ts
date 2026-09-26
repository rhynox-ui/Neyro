import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  // Neyro launches on mainnet; testnet must be chosen explicitly.
  NEAR_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  /** Defaults to FastNEAR for the selected network. */
  NEAR_RPC_URL: z.string().url().optional(),
  NEAR_RPC_FALLBACK_URL: z.string().url().optional(),
  FASTNEAR_API_URL: z.string().url().optional(),
  /**
   * FastNEAR API key (sent as Authorization: Bearer). Keyless access is
   * rate-limited per IP, and Cloudflare Workers share IPs, so production
   * needs a key.
   */
  FASTNEAR_API_KEY: z.string().optional(),
  RHEA_API_URL: z.string().url().default("https://api.rhea.finance"),
  RHEA_API_TOKEN: z.string().optional(),
  /** Account that receives protocol fees; fees are off when unset. */
  TREASURY_ACCOUNT_ID: z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).optional(),
  PROTOCOL_FEE_BPS: z.coerce.number().int().min(0).max(1_000).default(100),
  PROTOCOL_FEE_CAP_USD: z.coerce.number().positive().default(60),
  NEYRO_MASTER_KEY: z.string().optional(),
  DATABASE_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info"),
  /** Telegram sends this in X-Telegram-Bot-Api-Secret-Token on webhook calls (Workers). */
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  /** Protects the Worker's /setup-webhook endpoint. */
  SETUP_SECRET: z.string().optional()
}).superRefine((env, ctx) => {
  const rpcs = [env.NEAR_RPC_URL, env.NEAR_RPC_FALLBACK_URL].filter(Boolean) as string[];
  const mismatched = rpcs.filter((url) =>
    env.NEAR_NETWORK === "mainnet" ? /testnet/i.test(url) : /mainnet/i.test(url)
  );
  for (const url of mismatched) {
    ctx.addIssue({
      code: "custom",
      path: ["NEAR_RPC_URL"],
      message: `RPC ${url} does not match NEAR_NETWORK=${env.NEAR_NETWORK}`
    });
  }
  if (env.NEAR_NETWORK === "mainnet" && !env.DATABASE_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "DATABASE_URL is required on mainnet; in-memory wallets would lose keys on restart"
    });
  }
});

// `KEY=` lines in .env mean "unset", not an empty value.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== "")
);

const parsed = schema.parse(env);

export const config = {
  ...parsed,
  NEAR_RPC_URL: parsed.NEAR_RPC_URL ?? `https://rpc.${parsed.NEAR_NETWORK}.fastnear.com`
};

export const FASTNEAR_API_URL = config.FASTNEAR_API_URL ??
  (config.NEAR_NETWORK === "mainnet" ? "https://api.fastnear.com" : "https://test.api.fastnear.com");

/** Effective fee rate: zero unless a treasury is configured. */
export const FEE_BPS = config.TREASURY_ACCOUNT_ID ? config.PROTOCOL_FEE_BPS : 0;

/** RHEA liquidity and its token list exist on NEAR mainnet only. */
export const TRADING_ENABLED = config.NEAR_NETWORK === "mainnet";

/** Auth headers for FastNEAR hosts (RPC and REST) when a key is configured. */
export function fastnearHeaders(url: string): Record<string, string> {
  if (!config.FASTNEAR_API_KEY) return {};
  try {
    const host = new URL(url).hostname;
    return host === "fastnear.com" || host.endsWith(".fastnear.com")
      ? { Authorization: `Bearer ${config.FASTNEAR_API_KEY}` }
      : {};
  } catch {
    return {};
  }
}
