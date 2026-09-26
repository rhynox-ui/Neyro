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

export async function withRpcFallback<T>(
  operation: (provider: JsonRpcProvider, endpoint: RpcEndpoint) => Promise<T>
): Promise<T> {
  let lastError: unknown;

  for (const endpoint of RPC_ENDPOINTS) {
    try {
      return await operation(createRpcProvider(endpoint.url), endpoint);
    } catch (error) {
      lastError = error;
      console.warn(`NEAR RPC ${endpoint.name} failed; trying next endpoint`);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("All configured NEAR RPC endpoints failed");
}
