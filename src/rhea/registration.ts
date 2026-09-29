import type { Account } from "near-api-js";
import { getNearAccount } from "../near/account.js";

export const RHEA_AGGREGATED_DEX = "aggregatedex.near";

export type RheaRegistrationCheck = {
  tokens: string[];
  registered: string[];
  missing: string[];
};

function normalizeTokenList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function extractRheaRouteTokens(rawQuote: unknown, fallbackTokens: readonly string[]): string[] {
  if (rawQuote && typeof rawQuote === "object") {
    const raw = rawQuote as Record<string, unknown>;
    const candidates = [
      raw.tokens,
      raw.route && typeof raw.route === "object"
        ? (raw.route as Record<string, unknown>).tokens
        : undefined
    ];
    for (const candidate of candidates) {
      const tokens = normalizeTokenList(candidate);
      if (tokens.length > 0) return [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];
    }
  }
  return [...new Set(fallbackTokens.map((token) => token.trim()).filter(Boolean))];
}

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
  const raw = await account.viewFunction({
    contractId: RHEA_AGGREGATED_DEX,
    methodName: "query_user_tokens_registered",
    args: { user: account.accountId, tokens: uniqueTokens }
  });
  const states = parseRegistrationResult(raw, uniqueTokens);
  const registered = uniqueTokens.filter((_token, index) => states[index]);
  const missing = uniqueTokens.filter((_token, index) => !states[index]);
  return { tokens: uniqueTokens, registered, missing };
}

export async function requireRheaTokenRegistration(accountId: string, tokens: readonly string[]): Promise<RheaRegistrationCheck> {
  const check = await checkRheaTokenRegistration(getNearAccount(accountId), tokens);
  if (check.missing.length > 0) {
    throw new Error("RHEA token registration required before execution: " + check.missing.join(", ") + ". No trade transaction was submitted.");
  }
  return check;
}
