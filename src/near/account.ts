import type { Account } from "near-api-js";
import { createNearConnection } from "./client.js";

export async function getNearAccount(accountId: string): Promise<Account> {
  const near = await createNearConnection();
  return near.account(accountId);
}

export async function getNearBalance(accountId: string): Promise<string> {
  const account = await getNearAccount(accountId);
  const balance = await account.getAccountBalance();
  return balance.available;
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await getNearAccount(accountId);
    return true;
  } catch {
    return false;
  }
}
