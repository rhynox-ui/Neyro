import { Account, JsonRpcProvider } from "near-api-js";
import { config } from "../config.js";

export type NearConnection = {
  provider: JsonRpcProvider;
  account(accountId: string): Account;
};

export function createNearConnection(): NearConnection {
  const provider = new JsonRpcProvider({ url: config.NEAR_RPC_URL });
  return {
    provider,
    account(accountId: string) {
      return new Account(accountId, provider);
    }
  };
}
