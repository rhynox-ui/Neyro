export type WalletAccount = {
  accountId: string;
};

export type WalletTransactionAction =
  | {
      type: "FunctionCall";
      receiverId: string;
      methodName: string;
      args: Record<string, unknown>;
      gas: bigint;
      deposit: bigint;
    }
  | {
      type: "Transfer";
      receiverId: string;
      deposit: bigint;
    };

export type SignAndSendRequest = {
  signerId: string;
  receiverId: string;
  actions: WalletTransactionAction[];
};

export interface WebWalletConnector {
  readonly id: string;
  connect(): Promise<WalletAccount>;
  disconnect(): Promise<void>;
  getAccounts(): Promise<WalletAccount[]>;
  signAndSend(request: SignAndSendRequest): Promise<{ transactionHash?: string }>;
  /**
   * Signs several transactions in one wallet approval and sends them in
   * order. Results are positional; a missing hash means that transaction's
   * outcome is unknown, not that it failed.
   */
  signAndSendMany(requests: SignAndSendRequest[]): Promise<Array<{ transactionHash?: string }>>;
}

export class LockedWalletConnector implements WebWalletConnector {
  readonly id = "locked";

  async connect(): Promise<WalletAccount> {
    throw new Error("No browser wallet connector is enabled");
  }

  async disconnect(): Promise<void> {}

  async getAccounts(): Promise<WalletAccount[]> {
    return [];
  }

  async signAndSend(): Promise<{ transactionHash?: string }> {
    throw new Error("Transaction signing is disabled until a browser wallet is configured");
  }

  async signAndSendMany(): Promise<Array<{ transactionHash?: string }>> {
    throw new Error("Transaction signing is disabled until a browser wallet is configured");
  }
}
