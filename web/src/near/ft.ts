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

const ZERO_STORAGE = "0";

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
    if (error instanceof Error && /method|does not exist|unknown/i.test(error.message)) {
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
    if (error instanceof Error && /method|does not exist|unknown/i.test(error.message)) {
      return "unsupported";
    }
    throw error;
  }
}

export function isRegistered(storage: StorageBalance | null): boolean {
  return storage !== null && storage.total !== ZERO_STORAGE;
}
