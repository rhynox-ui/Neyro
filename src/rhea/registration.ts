import type { Account } from "near-api-js";
import { createNearConnection } from "../near/client.js";

export const RHEA_AGGREGATED_DEX = "aggregatedex.near";

export type RheaRegistrationCheck = {
  tokens: string[];
  registered: string[];
  missing: string[];
};

import { extractRheaRouteTokens } from "./route.js";
export { extractRheaRouteTokens } from "./route.js";

function parseRegistrationResult(value: unknown, tokens: readonly string[]): boolean[] {
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
  return check;
}
