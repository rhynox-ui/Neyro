import type { Account } from "near-api-js";
import { createNearConnection } from "./client.js";

export function getNearAccount(accountId: string): Account {
  return createNearConnection().account(accountId);
}

export async function getNearBalance(accountId: string): Promise<string> {
  const account = getNearAccount(accountId);
  return account.getBalance();
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await createNearConnection().provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}
