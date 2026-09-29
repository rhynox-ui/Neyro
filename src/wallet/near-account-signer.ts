import type { Account } from "near-api-js";
import type { NearTransaction } from "@rhea-finance/cross-chain-aggregation-dex";
import type { NearTransactionSigner } from "../near/rhea-executor.js";

type FinalOutcome = {
  transaction?: { hash?: string };
  status?: unknown;
};

type CachedOutcome = {
  status: "confirmed" | "failed";
  raw: FinalOutcome;
};

function isAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("NEAR transaction signing was cancelled");
  }
}

/**
 * Classify a NEAR final execution status.
 *
 * NEAR final outcomes must contain either a SuccessValue/SuccessReceiptId
 * status or a Failure status. Anything else is treated as unsafe/unknown and
 * rejected rather than being reported as confirmed.
 */
export function classifyFinalExecutionStatus(
  status: unknown
): "confirmed" | "failed" {
  if (status && typeof status === "object") {
    if ("Failure" in status) return "failed";
    if ("SuccessValue" in status || "SuccessReceiptId" in status) {
      return "confirmed";
    }
  }

  throw new Error("NEAR RPC returned an unknown final execution status");
}

/**
 * Adapter around a near-api-js Account.
 *
 * The Account owns the signer. Callers only see transaction hashes and
 * confirmation state; private keys never cross this boundary.
 */
export class NearAccountSigner implements NearTransactionSigner {
  private readonly outcomes = new Map<string, CachedOutcome>();

  constructor(private readonly account: Account) {}

  getAccountId(): string {
    return this.account.accountId;
  }

  async signAndSendTransactions(
    transactions: NearTransaction[],
    options: { signal?: AbortSignal }
  ): Promise<{ txHashes: string[]; raw?: unknown }> {
    const txHashes: string[] = [];
    const raw: FinalOutcome[] = [];

    for (const transaction of transactions) {
      isAbort(options.signal);

      const outcome = await this.account.signAndSendTransaction({
        receiverId: transaction.receiverId,
        actions: transaction.actions as never
      }) as FinalOutcome;

      const txHash = outcome.transaction?.hash;
      if (!txHash) {
        throw new Error("NEAR RPC returned no transaction hash");
      }

      const status = classifyFinalExecutionStatus(outcome.status);
      this.outcomes.set(txHash, { status, raw: outcome });

      txHashes.push(txHash);
      raw.push(outcome);

      if (status === "failed") {
        throw new Error(`NEAR transaction ${txHash} failed during final execution`);
      }
    }

    return { txHashes, raw };
  }

  async waitForTransactions(
    txHashes: string[],
    options: { signal?: AbortSignal }
  ): Promise<{ status: "confirmed" | "failed"; raw?: unknown }> {
    if (txHashes.length === 0) {
      return { status: "failed" };
    }

    const raw: FinalOutcome[] = [];

    for (const txHash of txHashes) {
      isAbort(options.signal);

      const cached = this.outcomes.get(txHash);
      if (!cached) {
        // We deliberately fail closed here. A transaction that was created by
        // another process or before this signer instance started must be
        // reconciled against NEAR RPC by the persistent execution/recovery
        // layer rather than being assumed successful.
        throw new Error(
          `NEAR transaction ${txHash} has no verified final outcome in this signer`
        );
      }

      raw.push(cached.raw);

      if (cached.status === "failed") {
        return { status: "failed", raw };
      }
    }

    return { status: "confirmed", raw };
  }
}
