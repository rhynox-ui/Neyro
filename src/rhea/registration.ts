import type { Account } from "near-api-js";
import type { NearTransaction } from "@rhea-finance/cross-chain-aggregation-dex";
import { storageRegistrationCost } from "../near/ft.js";
import { createNearConnection } from "../near/client.js";
import { extractRheaRouteTokens } from "./route.js";

export { extractRheaRouteTokens } from "./route.js";

export const RHEA_AGGREGATED_DEX = "aggregatedex.near";

export type RheaRegistrationCheck = {
  tokens: string[];
  registered: string[];
  missing: string[];
};

export function isTokenStorageRegistered(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const total = (value as Record<string, unknown>).total;
  if (typeof total !== "string" || !/^\d+$/.test(total)) return false;
  return BigInt(total) > 0n;
}

export function parseRegistrationResult(value: unknown, tokens: readonly string[]): boolean[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "boolean")) {
    if (value.length !== tokens.length) throw new Error("RHEA registration response length did not match requested tokens");
    return value;
  }
  if (typeof value === "boolean") {
    if (tokens.length !== 1) throw new Error("RHEA returned a scalar registration result for multiple tokens");
    return [value];
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nested = record.registered ?? record.result ?? record.data;
    if (Array.isArray(nested) && nested.every((item) => typeof item === "boolean")) {
      if (nested.length !== tokens.length) throw new Error("RHEA nested registration response length did not match requested tokens");
      return nested;
    }
  }
  throw new Error("RHEA returned an unrecognized token registration response");
}

export async function checkRheaTokenRegistration(account: Account, tokens: readonly string[]): Promise<RheaRegistrationCheck> {
  const uniqueTokens = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];
  if (uniqueTokens.length === 0) throw new Error("RHEA quote did not contain any executable tokens");

  const raw = await createNearConnection().provider.callFunction({
    contractId: RHEA_AGGREGATED_DEX,
    method: "query_user_tokens_registered",
    args: { user: account.accountId, tokens: uniqueTokens }
  });

  const states = parseRegistrationResult(raw, uniqueTokens);
  const registered = uniqueTokens.filter((_token, index) => states[index]);
  const missing = uniqueTokens.filter((_token, index) => !states[index]);
  return { tokens: uniqueTokens, registered, missing };
}

export async function requireRheaTokenRegistration(accountId: string, tokens: readonly string[]): Promise<RheaRegistrationCheck> {
  const account = createNearConnection().account(accountId);
  const check = await checkRheaTokenRegistration(account, tokens);

  if (check.missing.length > 0) {
    throw new Error("RHEA token registration required before execution: " + check.missing.join(", ") + ". No trade transaction was submitted.");
  }

  for (const token of check.tokens) {
    const [userStorage, aggregateStorage] = await Promise.all([
      createNearConnection().provider.callFunction({
        contractId: token,
        method: "storage_balance_of",
        args: { account_id: accountId }
      }),
      createNearConnection().provider.callFunction({
        contractId: token,
        method: "storage_balance_of",
        args: { account_id: RHEA_AGGREGATED_DEX }
      })
    ]);

    if (!isTokenStorageRegistered(userStorage) || !isTokenStorageRegistered(aggregateStorage)) {
      throw new Error(`RHEA token storage registration required for ${token}. No trade transaction was submitted.`);
    }
  }

  return check;
}

const AGGREGATE_TOKEN_STORAGE_YOCTO = 5_000_000_000_000_000_000_000n;
const REGISTRATION_GAS = "30000000000000";

export type RheaRegistrationPlan = {
  tokens: string[];
  transactions: NearTransaction[];
  requiredDeposit: bigint;
};

export async function buildRheaRegistrationPlan(
  accountId: string,
  tokens: readonly string[]
): Promise<RheaRegistrationPlan> {
  const uniqueTokens = [...new Set(tokens.map((token) => token.trim().toLowerCase().replace(/^nep141:/, "")).filter(Boolean))];
  if (uniqueTokens.length === 0) throw new Error("No RHEA tokens require registration");

  const check = await requireRheaTokenRegistrationState(accountId, uniqueTokens);
  const transactions: NearTransaction[] = [];
  let requiredDeposit = 0n;

  if (check.aggregateMissing.length > 0) {
    const deposit = AGGREGATE_TOKEN_STORAGE_YOCTO * BigInt(check.aggregateMissing.length);
    transactions.push({
      receiverId: RHEA_AGGREGATED_DEX,
      actions: [{
        type: "FunctionCall",
        params: {
          methodName: "tokens_storage_deposit",
          args: { user: accountId, tokens: check.aggregateMissing },
          gas: REGISTRATION_GAS,
          deposit: deposit.toString()
        }
      }]
    } as NearTransaction);
    requiredDeposit += deposit;
  }

  for (const item of check.tokenStorageMissing) {
    const targets = [accountId, RHEA_AGGREGATED_DEX].filter((target) => item.missingAccounts.includes(target));
    for (const target of targets) {
      const deposit = await storageRegistrationCost(item.token, target);
      if (deposit <= 0n) continue;
      transactions.push({
        receiverId: item.token,
        actions: [{
          type: "FunctionCall",
          params: {
            methodName: "storage_deposit",
            args: { account_id: target, registration_only: true },
            gas: REGISTRATION_GAS,
            deposit: deposit.toString()
          }
        }]
      } as NearTransaction);
      requiredDeposit += deposit;
    }
  }

  return { tokens: uniqueTokens, transactions, requiredDeposit };
}

async function requireRheaTokenRegistrationState(accountId: string, tokens: readonly string[]) {
  const account = createNearConnection().account(accountId);
  const raw = await createNearConnection().provider.callFunction({
    contractId: RHEA_AGGREGATED_DEX,
    method: "query_user_tokens_registered",
    args: { user: accountId, tokens }
  });
  const states = parseRegistrationResult(raw, tokens);
  const aggregateMissing = tokens.filter((_token, index) => !states[index]);
  const tokenStorageMissing: { token: string; missingAccounts: string[] }[] = [];

  for (const token of tokens) {
    const [userStorage, aggregateStorage] = await Promise.all([
      createNearConnection().provider.callFunction({
        contractId: token,
        method: "storage_balance_of",
        args: { account_id: accountId }
      }),
      createNearConnection().provider.callFunction({
        contractId: token,
        method: "storage_balance_of",
        args: { account_id: RHEA_AGGREGATED_DEX }
      })
    ]);
    const missingAccounts = [
      !isTokenStorageRegistered(userStorage) ? accountId : "",
      !isTokenStorageRegistered(aggregateStorage) ? RHEA_AGGREGATED_DEX : ""
    ].filter(Boolean);
    if (missingAccounts.length) tokenStorageMissing.push({ token, missingAccounts });
  }

  return { aggregateMissing, tokenStorageMissing };
}
