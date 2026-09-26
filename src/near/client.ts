import { connect, keyStores, providers, Near } from "near-api-js";
import { config } from "../config.js";

export async function createNearConnection(): Promise<Near> {
  return connect({
    networkId: config.NEAR_NETWORK,
    nodeUrl: config.NEAR_RPC_URL,
    headers: {},
    keyStore: new keyStores.InMemoryKeyStore(),
    provider: new providers.JsonRpcProvider({ url: config.NEAR_RPC_URL })
  });
}
