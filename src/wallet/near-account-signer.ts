import type { Account } from "near-api-js";
import { ActionExecutionError } from "near-api-js/rpc-errors";
import type { NearTransaction } from "@rhea-finance/cross-chain-aggregation-dex";
import type { NearTransactionSigner } from "../near/rhea-executor.js";
import {
  findExecutionFailure,
  isDefinitiveRejection,
  lookupTransaction,
  transactionHash
} from "../near/execution.js";

export type SentTransactionResult = "executed" | "reverted" | "rejected" | "unknown";

export type SentTransaction = {
  txHash: string;
  receiverId: string;
  result: SentTransactionResult;
  failure?: string;
};

export type SignerJournal = {
  /**
   * Called with the final hash after signing and before broadcast. If it
   * throws, the transaction is not sent, so an unrecorded broadcast can't happen.
   */
  beforeBroadcast?(txHash: string, receiverId: string): Promise<void>;
};

const WAIT_UNTIL = "EXECUTED_OPTIMISTIC";

function isAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("NEAR transaction signing was cancelled");
  }
}

/**
 * Adapter around a near-api-js Account.
 *
 * The Account owns the signer. Callers only see transaction hashes and
 * confirmation state; private keys never cross this boundary.
 *
 * Every transaction is signed first, its hash journaled, and only then
 * broadcast, so a timeout after broadcast still leaves a hash to reconcile.
 */
export class NearAccountSigner implements NearTransactionSigner {
  private readonly sentTransactions: SentTransaction[] = [];

  constructor(
    private readonly account: Account,
    private readonly journal: SignerJournal = {}
  ) {}

  getAccountId(): string {
    return this.account.accountId;
  }

  /** Every transaction this signer attempted to broadcast, in order. */
  get sent(): readonly SentTransaction[] {
    return this.sentTransactions;
  }

  async signAndSendTransactions(
    transactions: NearTransaction[],
    options: { signal?: AbortSignal }
  ): Promise<{ txHashes: string[]; raw?: unknown }> {
    const raw: unknown[] = [];

    for (const transaction of transactions) {
      isAbort(options.signal);

      const signed = await this.account.createSignedTransaction({
        receiverId: transaction.receiverId,
        actions: transaction.actions as never
      });
      const txHash = transactionHash(signed);
      await this.journal.beforeBroadcast?.(txHash, transaction.receiverId);

      const record: SentTransaction = {
        txHash,
        receiverId: transaction.receiverId,
        result: "unknown"
      };
      this.sentTransactions.push(record);

      let outcome: unknown;
      try {
        outcome = await this.account.provider.sendTransactionUntil(signed, WAIT_UNTIL);
      } catch (error) {
        if (error instanceof ActionExecutionError) {
          // Executed on chain and failed; the outcome is known.
          record.result = "reverted";
          record.failure = error.message.slice(0, 200);
          break;
        }
        if (isDefinitiveRejection(error)) record.result = "rejected";
        throw error;
      }

      raw.push(outcome);
      const failure = findExecutionFailure(outcome);
      if (failure) {
        record.result = "reverted";
        record.failure = failure;
        // Later transactions in a batch depend on earlier ones; stop here.
        break;
      }
      record.result = "executed";
    }

    return {
      txHashes: this.sentTransactions.map((item) => item.txHash),
      raw
    };
  }

  async waitForTransactions(
    txHashes: string[],
    _options: { signal?: AbortSignal }
  ): Promise<{ status: "confirmed" | "failed"; raw?: unknown }> {
    if (txHashes.length === 0) return { status: "failed" };

    // sendTransactionUntil(EXECUTED_OPTIMISTIC) returns only after every
    // receipt executed, so receipt-level results are already known here.
    const records = txHashes.map((hash) =>
      this.sentTransactions.find((item) => item.txHash === hash)
    );
    const confirmed = records.every((item) => item?.result === "executed");
    return { status: confirmed ? "confirmed" : "failed", raw: records };
  }

  /**
   * Re-queries the chain for transactions whose outcome is still unknown,
   * such as after an RPC timeout. Transactions the node has never seen stay unknown.
   */
  async reconcile(): Promise<void> {
    for (const record of this.sentTransactions) {
      if (record.result !== "unknown") continue;
      try {
        const lookup = await lookupTransaction(this.account.provider, record.txHash, this.account.accountId);
        record.result = lookup.result;
        if (lookup.failure) record.failure = lookup.failure;
      } catch {
        console.warn("NEAR transaction reconciliation failed");
      }
    }
  }
}
