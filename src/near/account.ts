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


export async function getFtBalance(
  accountId: string,
  tokenContract: string
): Promise<bigint> {
  return withRpcFallback(async (provider) => {
    const result = await provider.callFunction({
      contractId: tokenContract,
      method: "ft_balance_of",
      args: { account_id: accountId }
    });

    const raw = typeof result === "string"
      ? result
      : result && typeof result === "object" && "result" in result
        ? new TextDecoder().decode((result as { result: Uint8Array }).result)
        : (() => {
            throw new Error("Unexpected ft_balance_of RPC response");
          })();
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "string" || !/^\d+$/.test(parsed)) {
      throw new Error("NEAR FT balance response was invalid");
    }

    return BigInt(parsed);
  });
}
