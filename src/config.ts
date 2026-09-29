import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEAR_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.mainnet.fastnear.com"),
  NEAR_RPC_FALLBACK_URL: z.string().url().optional(),
  NEAR_SPENDABLE_RESERVE_YOCTO: z.string().regex(/^\d+$/).default("10000000000000000000000"),
  RHEA_API_URL: z.string().url().default("https://api.rhea.finance"),
  RHEA_API_TOKEN: z.string().optional(),
  NEYRO_MASTER_KEY: z.string().optional(),
  DATABASE_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info")
});

const parsed = schema.parse(process.env);

if (parsed.NEAR_NETWORK !== "mainnet") {
  throw new Error(
    "Neyro RHEA trading is configured for NEAR mainnet only; testnet trading is not supported by the current RHEA chain configuration"
  );
}

const rpcUrls = [parsed.NEAR_RPC_URL, parsed.NEAR_RPC_FALLBACK_URL].filter(
  (url): url is string => Boolean(url)
);

if (rpcUrls.some((url) => /testnet/i.test(url))) {
  throw new Error("NEAR mainnet mode cannot use a testnet RPC endpoint");
}

export const config = parsed;
