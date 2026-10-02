import type { NearRpcClient } from "./rpc";

export type FtMetadata = {
  spec: string;
  name: string;
  symbol: string;
  icon?: string | null;
  reference?: string | null;
  reference_hash?: string | null;
  decimals: number;
};

export type StorageBalance = {
  total: string;
  available?: string;
};

export type StorageBalanceBounds = {
  min: string;
  max: string | null;
};

const ZERO_STORAGE = "0";

function isStorageMethodUnavailable(error: unknown): boolean {
  return error instanceof Error && /method\s+(?:not found|does not exist)|unknown method|unknown function|not a function/i.test(error.message);
}

export async function getFtMetadata(
  rpc: NearRpcClient,
  tokenContract: string
): Promise<FtMetadata> {
  const metadata = await rpc.viewFunction<FtMetadata>(
    tokenContract,
    "ft_metadata"
  );

  if (
    !metadata ||
    typeof metadata.symbol !== "string" ||
    !Number.isInteger(metadata.decimals) ||
    metadata.decimals < 0
  ) {
    throw new Error("Token returned invalid ft_metadata");
  }

  return metadata;
}

export async function getFtBalance(
  rpc: NearRpcClient,
  tokenContract: string,
  accountId: string
): Promise<bigint> {
  const balance = await rpc.viewFunction<string>(tokenContract, "ft_balance_of", {
    account_id: accountId
  });

  if (!/^\d+$/.test(balance)) {
    throw new Error("Token returned invalid ft_balance_of");
  }

  return BigInt(balance);
}

export async function getStorageBalance(
  rpc: NearRpcClient,
  tokenContract: string,
  accountId: string
): Promise<StorageBalance | null> {
  try {
    return await rpc.viewFunction<StorageBalance | null>(
      tokenContract,
      "storage_balance_of",
      { account_id: accountId }
    );
  } catch (error) {
    // Some older/non-NEP-145 tokens do not expose storage_balance_of.
    // The caller must treat this as "unknown", not as registered.
    if (isStorageMethodUnavailable(error)) {
      return null;
    }
    throw error;
  }
}

export type StorageRegistrationState =
  | "registered"
  | "not-registered"
  | "unsupported";

export async function getStorageRegistrationState(
  rpc: NearRpcClient,
  tokenContract: string,
  accountId: string
): Promise<StorageRegistrationState> {
  try {
    const storage = await rpc.viewFunction<StorageBalance | null>(
      tokenContract,
      "storage_balance_of",
      { account_id: accountId }
    );
    return storage !== null && storage.total !== ZERO_STORAGE
      ? "registered"
      : "not-registered";
  } catch (error) {
    if (isStorageMethodUnavailable(error)) {
      return "unsupported";
    }
    throw error;
  }
}

export async function getStorageBalanceBounds(
  rpc: NearRpcClient,
  tokenContract: string
): Promise<StorageBalanceBounds> {
  const bounds = await rpc.viewFunction<StorageBalanceBounds>(
    tokenContract,
    "storage_balance_bounds",
    {}
  );

  if (
    !bounds ||
    !/^\d+$/.test(bounds.min) ||
    BigInt(bounds.min) <= 0n ||
    (bounds.max !== null && !/^\d+$/.test(bounds.max))
  ) {
    throw new Error("Token returned invalid storage_balance_bounds");
  }

  if (bounds.max !== null && BigInt(bounds.max) < BigInt(bounds.min)) {
    throw new Error("Token returned invalid storage balance bounds");
  }

  return bounds;
}

export function isRegistered(storage: StorageBalance | null): boolean {
  return storage !== null && storage.total !== ZERO_STORAGE;
}
