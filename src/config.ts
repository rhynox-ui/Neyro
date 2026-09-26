import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  NEAR_NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.fastnear.com"),
  NEAR_RPC_FALLBACK_URL: z.string().url().optional(),
  RHEA_API_URL: z.string().url().default("https://api.rhea.finance"),
  RHEA_API_TOKEN: z.string().optional(),
  NEYRO_MASTER_KEY: z.string().optional(),
  DATABASE_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info")
});

export const config = schema.parse(process.env);
