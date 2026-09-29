import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  NEAR_NETWORK: z.literal("mainnet").default("mainnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.mainnet.fastnear.com"),
  NEAR_RPC_FALLBACK_URL: z.string().url().optional(),
  NEAR_RPC_EXTRA_URLS: z.string().optional(),

  NEAR_SPENDABLE_RESERVE_YOCTO: z.string().regex(/^\d+$/).default("10000000000000000000000"),

  FASTNEAR_API_URL: z.string().url().optional(),
  FASTNEAR_API_KEY: z.string().optional(),

  RHEA_API_URL: z.string().url().default("https://api.rhea.finance"),
  RHEA_API_TOKEN: z.string().optional(),
  RHEA_EXTRA_CONTRACTS: z.string().optional(),

  TREASURY_ACCOUNT_ID: z.string().regex(/^(([a-z\d]+[-_])*([a-z\d]+\.)?)*([a-z\d]+[-_])*[a-z\d]+$/).optional(),
  PROTOCOL_FEE_BPS: z.coerce.number().int().min(0).max(1_000).default(100),
  PROTOCOL_FEE_CAP_USD: z.coerce.number().positive().default(60),

  NEYRO_MASTER_KEY: z.string().optional(),
  DATABASE_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info"),

  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),
  COINGECKO_API_PLAN: z.enum(["demo", "pro"]).default("demo"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  SETUP_SECRET: z.string().optional()
}).superRefine((env, ctx) => {
  const rpcs = [env.NEAR_RPC_URL, env.NEAR_RPC_FALLBACK_URL].filter(Boolean) as string[];

  if (rpcs.some((url) => /testnet/i.test(url))) {
    ctx.addIssue({
      code: "custom",
      path: ["NEAR_RPC_URL"],
      message: "Neyro is mainnet-only and cannot use a testnet RPC endpoint"
    });
  }

  if (!env.DATABASE_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "DATABASE_URL is required; persistent storage is mandatory for Neyro trading"
    });
  }
});

const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== "")
);

const parsed = schema.parse(env);

export const config = {
  ...parsed,
  NEAR_NETWORK: "mainnet" as const,
  NEAR_RPC_URL: parsed.NEAR_RPC_URL
};

export const FASTNEAR_API_URL =
  config.FASTNEAR_API_URL ?? "https://api.fastnear.com";

export const FEE_BPS = config.TREASURY_ACCOUNT_ID
  ? config.PROTOCOL_FEE_BPS
  : 0;

export const TRADING_ENABLED = true;

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
