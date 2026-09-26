import type { Account } from "near-api-js";
import type { NearTransaction } from "@rhea-finance/cross-chain-aggregation-dex";
import type { NearTransactionSigner } from "../near/rhea-executor.js";

type FinalOutcome = {
  transaction?: { hash?: string };
  status?: unknown;
};

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
 */
export class NearAccountSigner implements NearTransactionSigner {
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

      txHashes.push(txHash);
      raw.push(outcome);
    }

    return { txHashes, raw };
  }

  async waitForTransactions(
    txHashes: string[],
    _options: { signal?: AbortSignal }
  ): Promise<{ status: "confirmed" | "failed"; raw?: unknown }> {
    if (txHashes.length === 0) {
      return { status: "failed" };
    }

    // signAndSendTransaction waits for final execution before returning, so
    // the submission result is already source-confirmed by the time RHEA
    // asks us to wait. A future remote-signer implementation can replace
    // this method with explicit tx-status polling.
    return { status: "confirmed" };
  }
}
