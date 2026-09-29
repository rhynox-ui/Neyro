import {
  createNearExecutor,
  type NearWalletAdapter
} from "@rhea-finance/cross-chain-aggregation-dex/executors/near";
import type {
  ChainExecutor,
  ChainRef,
  NearTransaction
} from "@rhea-finance/cross-chain-aggregation-dex";

export interface NearTransactionSigner {
  getAccountId(): string;
  addAllowedReceivers?(receivers: readonly string[]): void;
  signAndSendTransactions(
    transactions: NearTransaction[],
    options: { signal?: AbortSignal }
  ): Promise<{ txHashes: string[]; raw?: unknown }>;
  signAndSendRegistrationTransactions?(
    transactions: NearTransaction[],
    options: { signal?: AbortSignal }
  ): Promise<{ txHashes: string[]; raw?: unknown }>;
  waitForTransactions(
    txHashes: string[],
    options: { signal?: AbortSignal }
  ): Promise<{ status: "confirmed" | "failed"; raw?: unknown }>;
}

export function createNeyroNearExecutor(
  signer: NearTransactionSigner
): ChainExecutor {
  const adapter: NearWalletAdapter = {
    getChain(): ChainRef {
      return "near";
    },
    async signAndSendTransactions(transactions, options) {
      return signer.signAndSendTransactions(transactions, options);
    },
    async waitForTransactions(txHashes, options) {
      return signer.waitForTransactions(txHashes, options);
    }
  };

  return createNearExecutor(adapter) as ChainExecutor;
}
