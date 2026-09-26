import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  NEAR_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.mainnet.near.org"),
  RHEA_API_URL: z.string().url().default("https://api.rhea.finance"),
  RHEA_API_TOKEN: z.string().optional(),
  NEYRO_MASTER_KEY: z.string().optional(),
  LOG_LEVEL: z.string().default("info")
});

export const config = schema.parse(process.env);
