import type { NearTransaction } from "@rhea-finance/cross-chain-aggregation-dex";
import { withRpcFallback } from "../near/rpc.js";
import { RHEA_AGGREGATED_DEX } from "./registration.js";

export type RheaInternalBalance = {
  token: string;
  amount: string;
};

function collectBalances(value: unknown, out: RheaInternalBalance[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBalances(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const token = [record.token, record.token_id, record.tokenId].find(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  );
  const amount = [record.amount, record.balance, record.available].find(
    (item): item is string | number => typeof item === "string" || typeof item === "number"
  );
  if (token && amount !== undefined && /^\d+$/.test(String(amount))) {
    out.push({ token: token.trim().toLowerCase().replace(/^nep141:/, ""), amount: String(amount) });
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") collectBalances(child, out);
  }
}

export function parseRheaInternalBalances(value: unknown): RheaInternalBalance[] {
  const out: RheaInternalBalance[] = [];
  collectBalances(value, out);
  const merged = new Map<string, bigint>();
  for (const item of out) {
    merged.set(item.token, (merged.get(item.token) ?? 0n) + BigInt(item.amount));
  }
  return [...merged.entries()].map(([token, amount]) => ({ token, amount: amount.toString() }));
}

export async function getRheaInternalBalances(accountId: string): Promise<RheaInternalBalance[]> {
  return withRpcFallback(async (provider) => {
    const raw = await provider.callFunction({
      contractId: RHEA_AGGREGATED_DEX,
      method: "query_user_exist_balance",
      args: { user: accountId, from_index: 0, count: 100 }
    });
    return parseRheaInternalBalances(raw);
  });
}

export function buildRheaWithdrawTransaction(
  token: string,
  returnNear = token.trim().toLowerCase().replace(/^nep141:/, "") === "wrap.near"
): NearTransaction {
  const normalized = token.trim().toLowerCase().replace(/^nep141:/, "");
  if (!normalized || normalized === RHEA_AGGREGATED_DEX) {
    throw new Error("Invalid RHEA recovery token");
  }
  return {
    receiverId: RHEA_AGGREGATED_DEX,
    actions: [{
      type: "FunctionCall",
      params: {
        methodName: "withdraw",
        args: { token: normalized, return_near: returnNear },
        gas: "30000000000000",
        deposit: "0"
      }
    }]
  } as NearTransaction;
}
