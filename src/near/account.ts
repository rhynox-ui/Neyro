import type { Account } from "near-api-js";
import { createNearConnection } from "./client.js";
import { withRpcFallback } from "./rpc.js";

export function getNearAccount(accountId: string): Account {
  return createNearConnection().account(accountId);
}

export async function getNearBalance(accountId: string): Promise<string> {
  return withRpcFallback(async (provider) => {
    const result = await provider.viewAccount({ accountId });
    return result.amount.toString();
  });
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    return await withRpcFallback(async (provider) => {
      await provider.viewAccount({ accountId });
      return true;
    });
  } catch {
    return false;
  }
}
