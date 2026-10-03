export type NearNetwork = "mainnet" | "testnet";

export type RpcErrorShape = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type RpcResponse<T> = {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: RpcErrorShape;
};

export type ViewAccountResult = {
  amount: string;
  locked: string;
  storage_usage: number;
  storage_paid_at: number;
  block_height: number;
  block_hash: string;
};

export type FunctionCallResult = {
  result: number[];
  logs: string[];
  block_height: number;
  block_hash: string;
};

export type TxStatusResult = {
  status: unknown;
  transaction?: unknown;
  transaction_outcome?: unknown;
  receipts_outcome?: unknown[];
};

export type AccessKeyListResult = {
  keys: Array<{
    public_key: string;
    access_key: { nonce: number | string; permission: unknown };
  }>;
  block_height: number;
  block_hash: string;
};

export type GasPriceResult = {
  gas_price: string;
};

export const NEAR_RPC_URLS: Record<NearNetwork, string[]> = {
  mainnet: [
    "https://rpc.mainnet.near.org",
    "https://rpc.mainnet.fastnear.com"
  ],
  testnet: [
    "https://rpc.testnet.near.org",
    "https://rpc.testnet.fastnear.com"
  ]
};

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(bytes: number[]): string {
  const binary = String.fromCharCode(...bytes);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0))
  );
}

export class NearRpcClient {
  readonly url: string;
  private requestId = 0;

  constructor(
    url = NEAR_RPC_URLS.mainnet[0],
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.url = url;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.requestId;
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    });

    if (!response.ok) {
      throw new Error(`NEAR RPC HTTP ${response.status}`);
    }

    const payload = (await response.json()) as RpcResponse<T>;
    if (payload.error) {
      const message =
        typeof payload.error.message === "string"
          ? payload.error.message
          : "NEAR RPC request failed";
      throw new Error(message);
    }
    if (payload.result === undefined) {
      throw new Error("NEAR RPC returned no result");
    }
    return payload.result;
  }

  async viewAccount(accountId: string): Promise<ViewAccountResult> {
    return this.request<ViewAccountResult>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId
    });
  }

  async viewFunction<T>(
    contractId: string,
    methodName: string,
    args: unknown = {}
  ): Promise<T> {
    const result = await this.request<FunctionCallResult>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: encodeBase64(JSON.stringify(args))
    });

    return JSON.parse(decodeBase64(result.result)) as T;
  }

  async gasPrice(): Promise<bigint> {
    const result = await this.request<GasPriceResult>("gas_price", [null]);
    if (!/^\d+$/.test(result.gas_price)) {
      throw new Error("NEAR RPC returned invalid gas price");
    }
    return BigInt(result.gas_price);
  }

  async transactionStatus(
    transactionHash: string,
    senderAccountId: string
  ): Promise<TxStatusResult> {
    return this.request<TxStatusResult>("tx", {
      tx_hash: transactionHash,
      sender_account_id: senderAccountId,
      wait_until: "FINAL"
    });
  }

  async viewAccessKeyList(accountId: string): Promise<AccessKeyListResult> {
    return this.request<AccessKeyListResult>("query", {
      request_type: "view_access_key_list",
      finality: "final",
      account_id: accountId
    });
  }

  /**
   * Number of blocks after which a transaction's referenced block hash is too
   * old for inclusion. Read live from the network rather than hardcoded.
   */
  async transactionValidityPeriod(): Promise<number> {
    const result = await this.request<{ transaction_validity_period?: unknown }>(
      "EXPERIMENTAL_genesis_config",
      {}
    );
    const period = result.transaction_validity_period;
    if (typeof period !== "number" || !Number.isSafeInteger(period) || period <= 0) {
      throw new Error("NEAR RPC returned an invalid transaction validity period");
    }
    return period;
  }
}
