import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEAR_NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.fastnear.com"),
  NEAR_RPC_FALLBACK_URL: z.string().url().optional(),
  NEAR_SPENDABLE_RESERVE_YOCTO: z.string().regex(/^\d+$/).default("10000000000000000000000"),
  RHEA_API_URL: z.string().url().default("https://api.rhea.finance"),
  RHEA_API_TOKEN: z.string().optional(),
  NEYRO_MASTER_KEY: z.string().optional(),
  DATABASE_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info")
});

export const config = schema.parse(process.env);
