import type { Account } from "near-api-js";
import { ActionExecutionError } from "near-api-js/rpc-errors";
import type { NearTransaction } from "@rhea-finance/cross-chain-aggregation-dex";
import type { NearTransactionSigner } from "../near/rhea-executor.js";
import { parseWalletAction, toNearApiAction, type WalletAction } from "../near/actions.js";
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

export type PlannedTransaction = {
  receiverId: string;
  actions: WalletAction[];
};

export type SignerJournal = {
  transform?(transactions: PlannedTransaction[]): PlannedTransaction[];
  beforeBroadcast?(txHash: string, receiverId: string): Promise<void>;
  allowedReceivers?: readonly string[];
};

export const RHEA_AGGREGATED_DEX = "aggregatedex.near";

export function classifyFinalExecutionStatus(
  status: unknown
): "confirmed" | "failed" {
  if (!status || typeof status !== "object") {
    throw new Error("NEAR RPC returned an unknown final execution status");
  }

  if (Object.prototype.hasOwnProperty.call(status, "Failure")) {
    return "failed";
  }

  if (
    Object.prototype.hasOwnProperty.call(status, "SuccessValue") ||
    Object.prototype.hasOwnProperty.call(status, "SuccessReceiptId")
  ) {
    return "confirmed";
  }

  throw new Error("NEAR RPC returned an unknown final execution status");
}

export function assertAllowedNearReceiver(
  receiverId: string,
  allowedReceivers: readonly string[]
): void {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/^nep141:/, "");

  const allowed = new Set([
    normalize(RHEA_AGGREGATED_DEX),
    ...allowedReceivers.map(normalize)
  ]);

  if (!allowed.has(normalize(receiverId))) {
    throw new Error(
      `NEAR execution blocked: unexpected contract ${receiverId}`
    );
  }
}

const WAIT_UNTIL = "EXECUTED_OPTIMISTIC";

function isAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("NEAR transaction signing was cancelled");
  }
}

function executionStatusOf(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "status")) return record.status;
  if (Object.prototype.hasOwnProperty.call(record, "outcome")) {
    return executionStatusOf(record.outcome);
  }
  return value;
}

export class NearAccountSigner implements NearTransactionSigner {
  private readonly sentTransactions: SentTransaction[] = [];
  private readonly extraAllowedReceivers = new Set<string>();

  constructor(
    private readonly account: Account,
    private readonly journal: SignerJournal = {}
  ) {}

  getAccountId(): string {
    return this.account.accountId;
  }

  get sent(): readonly SentTransaction[] {
    return this.sentTransactions;
  }

  addAllowedReceivers(receivers: readonly string[]): void {
    for (const receiver of receivers) this.extraAllowedReceivers.add(receiver);
  }

  private allowedReceivers(): string[] {
    return [
      ...(this.journal.allowedReceivers ?? []),
      ...this.extraAllowedReceivers
    ];
  }

  private async sendTransactions(
    transactions: NearTransaction[],
    options: { signal?: AbortSignal },
    applyTransform: boolean
  ): Promise<{ txHashes: string[]; raw?: unknown }> {
    const raw: unknown[] = [];
    let planned: PlannedTransaction[] = transactions.map((transaction) => ({
      receiverId: transaction.receiverId,
      actions: transaction.actions.map(parseWalletAction)
    }));

    if (applyTransform && this.journal.transform) {
      planned = this.journal.transform(planned);
    }

    for (const transaction of planned) {
      isAbort(options.signal);
      if (this.journal.allowedReceivers || this.extraAllowedReceivers.size > 0) {
        assertAllowedNearReceiver(transaction.receiverId, this.allowedReceivers());
      }

      const signed = await this.account.createSignedTransaction({
        receiverId: transaction.receiverId,
        actions: transaction.actions.map(toNearApiAction)
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
        break;
      }

      try {
        classifyFinalExecutionStatus(executionStatusOf(outcome));
        record.result = "executed";
      } catch (error) {
        record.result = "unknown";
        record.failure = error instanceof Error ? error.message : "unknown NEAR execution status";
        break;
      }
    }

    return {
      txHashes: this.sentTransactions.map((item) => item.txHash),
      raw
    };
  }

  async signAndSendRegistrationTransactions(
    transactions: NearTransaction[],
    options: { signal?: AbortSignal }
  ): Promise<{ txHashes: string[]; raw?: unknown }> {
    if (transactions.length === 0) return { txHashes: [], raw: [] };

    for (const transaction of transactions) {
      for (const action of transaction.actions) {
        const parsed = parseWalletAction(action);
        if (
          parsed.type !== "FunctionCall" ||
          !["tokens_storage_deposit", "storage_deposit"].includes(parsed.params.methodName)
        ) {
          throw new Error("NEAR registration execution blocked: unexpected action");
        }
      }
    }

    return this.sendTransactions(transactions, options, false);
  }

  async signAndSendTransactions(
    transactions: NearTransaction[],
    options: { signal?: AbortSignal }
  ): Promise<{ txHashes: string[]; raw?: unknown }> {
    return this.sendTransactions(transactions, options, true);
  }

  async waitForTransactions(
    txHashes: string[],
    _options: { signal?: AbortSignal }
  ): Promise<{ status: "confirmed" | "failed"; raw?: unknown }> {
    if (txHashes.length === 0) return { status: "failed" };

    const records = txHashes.map((hash) =>
      this.sentTransactions.find((item) => item.txHash === hash)
    );

    const confirmed = records.every((item) => item?.result === "executed");

    return {
      status: confirmed ? "confirmed" : "failed",
      raw: records
    };
  }

  async reconcile(): Promise<void> {
    for (const record of this.sentTransactions) {
      if (record.result !== "unknown") continue;

      try {
        const lookup = await lookupTransaction(
          this.account.provider,
          record.txHash,
          this.account.accountId
        );

        record.result = lookup.result;

        if (lookup.failure) {
          record.failure = lookup.failure;
        }
      } catch {
        console.warn("NEAR transaction reconciliation failed");
      }
    }
  }
}
