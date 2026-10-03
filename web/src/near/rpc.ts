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

/**
 * Free public RPC providers listed in the official NEAR docs
 * (docs.near.org/api/rpc/providers). The `*.near.org` endpoints are
 * deprecated and heavily rate-limited since 2025, so they are not used.
 */
export const NEAR_RPC_URLS: Record<NearNetwork, string[]> = {
  mainnet: [
    "https://free.rpc.fastnear.com",
    "https://near.drpc.org"
  ],
  testnet: [
    "https://test.rpc.fastnear.com",
    "https://near-testnet.drpc.org"
  ]
};

/** A provider-side problem worth retrying on the next provider. */
class ProviderUnavailable extends Error {}

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
  readonly urls: readonly string[];
  private requestId = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(
    urls: string | readonly string[] = NEAR_RPC_URLS.mainnet,
    fetchImpl?: typeof fetch
  ) {
    this.urls = typeof urls === "string" ? [urls] : urls;
    if (this.urls.length === 0) throw new Error("At least one NEAR RPC URL is required");
    // Browsers throw "Illegal invocation" when fetch is called with a `this`
    // other than the global object, so never store the bare function.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  get url(): string {
    return this.urls[0];
  }

  /**
   * Sends one JSON-RPC request, failing over to the next provider only on
   * transport errors, HTTP 429 or 5xx. RPC-level errors (unknown account,
   * method panics) are answers, not outages, and are returned immediately.
   * Only read methods are sent through this client; transactions are sent
   * by the wallet, so a retry here can never duplicate a transaction.
   */
  async request<T>(method: string, params: unknown): Promise<T> {
    let lastError: unknown;
    for (const url of this.urls) {
      try {
        return await this.requestOnce<T>(url, method, params);
      } catch (error) {
        if (!(error instanceof ProviderUnavailable)) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? new Error(lastError.message) : new Error("NEAR RPC unavailable");
  }

  private async requestOnce<T>(url: string, method: string, params: unknown): Promise<T> {
    const id = ++this.requestId;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
      });
    } catch (error) {
      throw new ProviderUnavailable(
        `NEAR RPC ${new URL(url).host} unreachable: ${error instanceof Error ? error.message : "network error"}`
      );
    }

    if (response.status === 429 || response.status >= 500) {
      throw new ProviderUnavailable(`NEAR RPC ${new URL(url).host} HTTP ${response.status}`);
    }
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
