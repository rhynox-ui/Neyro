import { Account, type JsonRpcProvider } from "near-api-js";
import { createFailoverProvider } from "./rpc.js";

export type NearConnection = {
  provider: JsonRpcProvider;
  account(accountId: string): Account;
};

/** Every call on this provider fails over across all configured RPC endpoints. */
export function createNearConnection(): NearConnection {
  const provider = createFailoverProvider() as JsonRpcProvider;
  return {
    provider,
    account(accountId: string) {
      return new Account(accountId, provider);
    }
  };
}
