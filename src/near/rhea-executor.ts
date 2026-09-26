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
  signAndSendTransactions(
    transactions: NearTransaction[],
    options: { signal?: AbortSignal }
  ): Promise<{ txHashes: string[]; raw?: unknown }>;
  waitForTransactions(
    txHashes: string[],
    options: { signal?: AbortSignal }
  ): Promise<{ status: "confirmed" | "failed"; raw?: unknown }>;
}

/**
 * RHEA execution adapter. The signer implementation is deliberately injected
 * so Telegram handlers never receive or manipulate private keys.
 */
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
