import { withRpcFallback } from "./rpc.js";

export function parseFtBalance(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Invalid ft_balance_of response");
  }
  return value;
}

/** NEP-141 balance in base units. */
export async function ftBalanceOf(contractId: string, accountId: string): Promise<bigint> {
  return withRpcFallback(async (provider) => {
    // near-api-js 7 already decodes the JSON view result; NEP-141 returns
    // the balance as a JSON string (U128), so a string is the only valid shape.
    const result = await provider.callFunction({
      contractId,
      method: "ft_balance_of",
      args: { account_id: accountId }
    });
    return BigInt(parseFtBalance(result));
  });
}

export type FtMetadata = {
  contractId: string;
  symbol: string;
  name?: string;
  decimals: number;
  /** Raw icon: usually a data: URI, sometimes an https/ipfs URL. */
  icon?: string;
};

export function parseFtMetadata(contractId: string, value: unknown): FtMetadata {
  if (!value || typeof value !== "object") throw new Error("Invalid ft_metadata response");
  const { symbol, name, decimals, spec, icon } = value as Record<string, unknown>;
  if (typeof spec !== "string" || !spec.startsWith("ft-")) {
    throw new Error(`${contractId} is not a NEP-141 token`);
  }
  if (typeof symbol !== "string" || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 64) {
    throw new Error("Invalid ft_metadata response");
  }
  return {
    contractId,
    symbol: symbol.slice(0, 32),
    ...(typeof name === "string" ? { name: name.slice(0, 64) } : {}),
    decimals: decimals as number,
    // Icons are capped by the token's own storage; ignore anything unreasonably large.
    ...(typeof icon === "string" && icon.length > 0 && icon.length <= 200_000 ? { icon } : {})
  };
}

// Token metadata is effectively immutable; cache it for the process lifetime.
const metadataCache = new Map<string, FtMetadata>();

export async function ftMetadata(contractId: string): Promise<FtMetadata> {
  const cached = metadataCache.get(contractId);
  if (cached) return cached;
  const metadata = await withRpcFallback(async (provider) =>
    parseFtMetadata(contractId, await provider.callFunction({
      contractId,
      method: "ft_metadata",
      args: {}
    }))
  );
  metadataCache.set(contractId, metadata);
  return metadata;
}

/**
 * yoctoNEAR needed to register `accountId` for storage on an FT contract;
 * 0 when it is already registered.
 */
export async function storageRegistrationCost(contractId: string, accountId: string): Promise<bigint> {
  return withRpcFallback(async (provider) => {
    const balance = await provider.callFunction({
      contractId,
      method: "storage_balance_of",
      args: { account_id: accountId }
    });
    if (balance) return 0n;
    const bounds = await provider.callFunction({ contractId, method: "storage_balance_bounds", args: {} });
    const min = (bounds as { min?: unknown } | undefined)?.min;
    if (typeof min !== "string" || !/^\d+$/.test(min)) throw new Error("Invalid storage_balance_bounds response");
    return BigInt(min);
  });
}
