import { JsonRpcProvider } from "near-api-js";
import { config } from "../config.js";

export type RpcEndpoint = {
  name: string;
  url: string;
};

export const RPC_ENDPOINTS: readonly RpcEndpoint[] = [
  { name: "primary", url: config.NEAR_RPC_URL },
  ...(config.NEAR_RPC_FALLBACK_URL
    ? [{ name: "fallback", url: config.NEAR_RPC_FALLBACK_URL }]
    : [])
];

export function createRpcProvider(url: string): JsonRpcProvider {
  return new JsonRpcProvider({ url });
}
