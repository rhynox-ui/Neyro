import { JsonRpcProvider, type Provider } from "near-api-js";
import {
  AccessKeyDoesNotExistError,
  AccountDoesNotExistError,
  ContractExecutionError
} from "near-api-js/rpc-errors";
import { config, fastnearHeaders } from "../config.js";
import { firstSuccess } from "../net/fallback.js";
import { isDefinitiveRejection } from "./execution.js";

export type RpcEndpoint = {
  name: string;
  url: string;
};

/**
 * Public, keyless endpoints from NEAR's provider list
 * (docs.near.org/api/rpc/providers), used after the configured ones.
 * rpc.mainnet.near.org is deprecated for backend use and not included.
 */
const PUBLIC_RPCS: Record<"mainnet" | "testnet", string[]> = {
  mainnet: [
    "https://rpc.mainnet.fastnear.com",
    "https://near.drpc.org",
    "https://rpc.intea.rs",
    "https://near.blockpi.network/v1/rpc/public",
    "https://free.rpc.fastnear.com",
    "https://rpc.shitzuapes.xyz"
  ],
  testnet: [
    "https://test.rpc.fastnear.com",
    "https://near-testnet.drpc.org",
    "https://testnet-rpc.intea.rs"
  ]
};

function endpointName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Configured primary and fallback first, then the public list, without duplicates. */
export function buildRpcEndpoints(primary: string, fallback: string | undefined, extra: readonly string[]): RpcEndpoint[] {
  const seen = new Set<string>();
  const endpoints: RpcEndpoint[] = [];
  const add = (name: string, url: string | undefined) => {
    if (!url) return;
    const key = url.replace(/\/+$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push({ name, url });
  };
  add("primary", primary);
  add("fallback", fallback);
  for (const url of extra) add(endpointName(url), url);
  return endpoints;
}

export const RPC_ENDPOINTS: readonly RpcEndpoint[] = buildRpcEndpoints(
  config.NEAR_RPC_URL,
  config.NEAR_RPC_FALLBACK_URL,
  config.NEAR_RPC_EXTRA_URLS
    ? config.NEAR_RPC_EXTRA_URLS.split(",").map((url) => url.trim()).filter(Boolean)
    : PUBLIC_RPCS[config.NEAR_NETWORK]
);

const providers = new Map<string, JsonRpcProvider>();

/** One provider per URL; few retries so a failing endpoint hands over quickly. */
export function createRpcProvider(url: string): JsonRpcProvider {
  let provider = providers.get(url);
  if (!provider) {
    provider = new JsonRpcProvider({ url, headers: fastnearHeaders(url) }, { retries: 1, wait: 250, backoff: 1.5 });
    providers.set(url, provider);
  }
  return provider;
}

/**
 * Answers every node gives identically, so failing over only wastes time:
 * missing accounts/keys, contract panics, and transactions the network
 * rejected before execution (bad nonce, insufficient balance, ...).
 */
function isDefinitive(error: unknown): boolean {
  return error instanceof AccountDoesNotExistError ||
    error instanceof AccessKeyDoesNotExistError ||
    error instanceof ContractExecutionError ||
    isDefinitiveRejection(error);
}

export async function withRpcFallback<T>(
  operation: (provider: JsonRpcProvider, endpoint: RpcEndpoint) => Promise<T>
): Promise<T> {
  return firstSuccess(
    RPC_ENDPOINTS.map((endpoint) => ({
      name: `rpc:${endpoint.name}`,
      run: () => operation(createRpcProvider(endpoint.url), endpoint)
    })),
    { isDefinitive, cooldownMs: 30_000 }
  );
}

/**
 * A Provider whose every method fails over across RPC_ENDPOINTS, for
 * near-api-js Account (signing, nonce and block lookups, broadcasting).
 * Rebroadcasting the same signed transaction to another node is safe: it
 * has the same hash and can only execute once. Errors keep their original
 * types, so definitive rejections still classify correctly.
 */
export function createFailoverProvider(): Provider {
  const primary = createRpcProvider(RPC_ENDPOINTS[0]!.url);
  return new Proxy(primary, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || property === "constructor") return value;
      return (...args: unknown[]) =>
        withRpcFallback((provider) => (provider as unknown as Record<PropertyKey, (...a: unknown[]) => Promise<unknown>>)[property]!(...args));
    }
  }) as unknown as Provider;
}
