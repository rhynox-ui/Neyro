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
    const result = await provider.query({
      request_type: "call_function",
      account_id: tokenContract,
      method_name: "ft_balance_of",
      args_base64: Buffer.from(
        JSON.stringify({ account_id: accountId }),
        "utf8"
      ).toString("base64"),
      finality: "final"
    });

    const raw = new TextDecoder().decode(Uint8Array.from(result.result));
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "string" || !/^\d+$/.test(parsed)) {
      throw new Error("NEAR FT balance response was invalid");
    }

    return BigInt(parsed);
  });
}
