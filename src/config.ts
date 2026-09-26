import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  NEAR_NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.fastnear.com"),
  NEAR_RPC_FALLBACK_URL: z.string().url().optional(),
  FASTNEAR_API_URL: z.string().url().optional(),
  RHEA_API_URL: z.string().url().default("https://api.rhea.finance"),
  RHEA_API_TOKEN: z.string().optional(),
  /** Account that receives protocol fees; fees are off when unset. */
  TREASURY_ACCOUNT_ID: z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).optional(),
  PROTOCOL_FEE_BPS: z.coerce.number().int().min(0).max(1_000).default(100),
  PROTOCOL_FEE_CAP_USD: z.coerce.number().positive().default(60),
  NEYRO_MASTER_KEY: z.string().optional(),
  DATABASE_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info")
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

export const config = schema.parse(env);

export const FASTNEAR_API_URL = config.FASTNEAR_API_URL ??
  (config.NEAR_NETWORK === "mainnet" ? "https://api.fastnear.com" : "https://test.api.fastnear.com");

/** Effective fee rate: zero unless a treasury is configured. */
export const FEE_BPS = config.TREASURY_ACCOUNT_ID ? config.PROTOCOL_FEE_BPS : 0;

/** RHEA liquidity and its token list exist on NEAR mainnet only. */
export const TRADING_ENABLED = config.NEAR_NETWORK === "mainnet";
