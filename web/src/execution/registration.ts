import { WalletPopupBlockedError, type SignAndSendRequest, type WebWalletConnector } from "../wallet/connector";
import type { NearRpcClient } from "../near/rpc";
import {
  buildStorageRegistrationTransaction,
  MAX_STORAGE_REGISTRATION_ACTIONS,
  STORAGE_DEPOSIT_GAS
} from "./transaction-builder";
import { getStorageBalance, getStorageBalanceBounds } from "../near/ft";
import type { RegistrationStore } from "../campaign/storage";
import { withCampaignLock } from "./campaign-lock";

export type RegistrationBatchStatus =
  | "pending"
  | "signing"
  | "submitted"
  | "success"
  | "failed"
  | "unknown";

export type RegistrationBatch = {
  id: string;
  tokenContract: string;
  payerId: string;
  recipientIds: string[];
  deposit: string;
  status: RegistrationBatchStatus;
  transactionHash?: string;
  error?: string;
  updatedAt: number;
};

export type RegistrationSession = {
  id: string;
  tokenContract: string;
  payerId: string;
  recipients: string[];
  deposit: string;
  status: "planned" | "running" | "paused" | "completed";
  createdAt: number;
  updatedAt: number;
  batches: RegistrationBatch[];
};

function hasSuccess(status: unknown): boolean {
  return Boolean(
    status &&
      typeof status === "object" &&
      ("SuccessValue" in status || "SuccessReceiptId" in status)
  );
}

function hasFailure(status: unknown): boolean {
  return Boolean(status && typeof status === "object" && "Failure" in status);
}

function transition(
  batch: RegistrationBatch,
  status: RegistrationBatchStatus,
  patch: Partial<Pick<RegistrationBatch, "transactionHash" | "error">> = {}
): RegistrationBatch {
  const allowed: Record<RegistrationBatchStatus, RegistrationBatchStatus[]> = {
    pending: ["signing", "failed"],
    signing: ["submitted", "failed", "unknown"],
    submitted: ["success", "failed", "unknown"],
    success: [],
    failed: ["pending"],
    unknown: ["success", "failed"]
  };
  if (!allowed[batch.status].includes(status)) {
    throw new Error(`Invalid registration transition: ${batch.status} -> ${status}`);
  }
  return { ...batch, ...patch, status, updatedAt: Date.now() };
}

export async function registrationSessionId(
  tokenContract: string,
  payerId: string,
  recipients: readonly string[]
): Promise<string> {
  const bytes = new TextEncoder().encode(
    [tokenContract, payerId, ...recipients].join("|")
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeBatches(
  tokenContract: string,
  payerId: string,
  recipients: readonly string[],
  deposit: bigint
): RegistrationBatch[] {
  const batches: RegistrationBatch[] = [];
  for (let offset = 0; offset < recipients.length; offset += MAX_STORAGE_REGISTRATION_ACTIONS) {
    batches.push({
      id: `registration-${offset / MAX_STORAGE_REGISTRATION_ACTIONS + 1}`,
      tokenContract,
      payerId,
      recipientIds: recipients.slice(offset, offset + MAX_STORAGE_REGISTRATION_ACTIONS),
      deposit: deposit.toString(),
      status: "pending",
      updatedAt: Date.now()
    });
  }
  return batches;
}

type RegistrationInput = {
  tokenContract: string;
  payerId: string;
  recipientIds: readonly string[];
  wallet: WebWalletConnector;
  rpc: NearRpcClient;
  store: RegistrationStore;
  /** Cross-tab lock manager; defaults to `navigator.locks`. */
  locks?: LockManager;
};

const lockName = (sessionId: string) => `registration:${sessionId}`;

export async function executeRecipientRegistration(
  input: RegistrationInput
): Promise<RegistrationSession> {
  const recipients = [...new Set(input.recipientIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (recipients.length === 0) throw new Error("No recipients require registration");

  const sessionId = await registrationSessionId(input.tokenContract, input.payerId, recipients);
  return withCampaignLock(
    lockName(sessionId),
    () => executeRegistrationLocked(input, recipients, sessionId),
    input.locks
  );
}

async function executeRegistrationLocked(
  input: RegistrationInput,
  recipients: string[],
  sessionId: string
): Promise<RegistrationSession> {
  const bounds = await getStorageBalanceBounds(input.rpc, input.tokenContract);
  const deposit = BigInt(bounds.min);
  let session = await input.store.getRegistration(sessionId);

  if (!session) {
    session = {
      id: sessionId,
      tokenContract: input.tokenContract,
      payerId: input.payerId,
      recipients,
      deposit: deposit.toString(),
      status: "planned",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      batches: makeBatches(input.tokenContract, input.payerId, recipients, deposit)
    };
    await input.store.putRegistration(session);
  } else if (
    session.tokenContract !== input.tokenContract ||
    session.payerId !== input.payerId ||
    session.recipients.join("|") !== recipients.join("|")
  ) {
    throw new Error("Existing registration session does not match this request");
  }

  if (session.deposit !== deposit.toString()) {
    throw new Error(
      "Token storage minimum changed since this registration session was created. Start a new registration session."
    );
  }

  const connected = await input.wallet.getAccounts();
  if (!connected.some((account) => account.accountId === input.payerId)) {
    throw new Error(`Connect payer account ${input.payerId} in the browser wallet before registration`);
  }

  for (let index = 0; index < session.batches.length; index += 1) {
    const batch = session.batches[index];
    if (batch.status === "success") continue;
    if (batch.status === "unknown" || batch.status === "submitted" || batch.status === "signing") {
      session.status = "paused";
      await input.store.putRegistration(session);
      throw new Error(`Registration batch ${batch.id} needs reconciliation before retrying`);
    }

    const account = await input.rpc.viewAccount(input.payerId);
    const gasPrice = await input.rpc.gasPrice();
    const batchGas = BigInt(batch.recipientIds.length) * STORAGE_DEPOSIT_GAS;
    const requiredForBatch = BigInt(batch.recipientIds.length) * deposit + batchGas * gasPrice;
    if (BigInt(account.amount) < requiredForBatch) {
      throw new Error("Registration payer does not have enough NEAR for the next registration batch");
    }

    // A confirmed failure re-enters the normal path through pending; the old
    // failed hash belongs to the previous attempt and must not be reused.
    const retryable = batch.status === "failed"
      ? { ...transition(batch, "pending"), transactionHash: undefined }
      : batch;
    session.batches[index] = transition(retryable, "signing");
    session.status = "running";
    session.updatedAt = Date.now();
    await input.store.putRegistration(session);

    const request: SignAndSendRequest = buildStorageRegistrationTransaction(
      input.payerId,
      input.tokenContract,
      batch.recipientIds,
      deposit
    );

    try {
      const outcome = await input.wallet.signAndSend(request);
      if (!outcome.transactionHash) {
        session.batches[index] = transition(session.batches[index], "unknown", {
          error: "Wallet returned without a transaction hash"
        });
        session.status = "paused";
        await input.store.putRegistration(session);
        throw new Error("Registration wallet result is unknown; reconcile before retrying");
      }

      session.batches[index] = transition(session.batches[index], "submitted", {
        transactionHash: outcome.transactionHash,
        error: undefined
      });
      await input.store.putRegistration(session);

      const result = await input.rpc.transactionStatus(outcome.transactionHash, input.payerId);
      if (hasFailure(result.status)) {
        throw new Error(`Registration transaction ${outcome.transactionHash} failed on-chain`);
      }
      if (!hasSuccess(result.status)) {
        throw new Error(`Registration transaction ${outcome.transactionHash} did not reach final success`);
      }

      session.batches[index] = transition(session.batches[index], "success", {
        error: undefined
      });
      session.status = index === session.batches.length - 1 ? "completed" : "running";
      session.updatedAt = Date.now();
      await input.store.putRegistration(session);
    } catch (error) {
      const current = session.batches[index];
      if (error instanceof WalletPopupBlockedError && current.status === "signing") {
        session.batches[index] = transition(current, "failed", { error: error.message });
      } else if (current.status === "submitted" || current.status === "signing") {
        session.batches[index] = transition(current, "unknown", {
          error: error instanceof Error ? error.message : "Registration outcome is unknown"
        });
      }
      session.status = "paused";
      session.updatedAt = Date.now();
      await input.store.putRegistration(session);
      throw error;
    }
  }

  session.status = session.batches.every((batch) => batch.status === "success") ? "completed" : "paused";
  session.updatedAt = Date.now();
  await input.store.putRegistration(session);
  return session;
}

/**
 * Resolves unresolved registration batches.
 *
 * A batch with a hash is resolved from its final transaction status. A batch
 * without one (wallet closed, interrupted signing) is resolved from chain
 * state instead: if every recipient is now registered the batch succeeded,
 * otherwise it is marked failed and may be retried. Retrying is safe because
 * the builder sends `registration_only: true`, and NEP-145 refunds the whole
 * deposit for an account that is already registered, so a late duplicate
 * costs only gas.
 */
export async function reconcileRecipientRegistration(
  sessionId: string,
  store: RegistrationStore,
  rpc: NearRpcClient,
  locks?: LockManager
): Promise<RegistrationSession> {
  return withCampaignLock(lockName(sessionId), async () => {
    const session = await store.getRegistration(sessionId);
    if (!session) throw new Error(`Registration session ${sessionId} was not found`);

    for (let index = 0; index < session.batches.length; index += 1) {
      let batch = session.batches[index];
      if (batch.status === "signing") {
        // Holding the lock means no tab is signing: this attempt was interrupted.
        batch = transition(batch, "unknown", {
          error: "Signing was interrupted before the wallet returned a transaction hash"
        });
      }
      if (batch.status !== "unknown" && batch.status !== "submitted") continue;

      try {
        if (batch.transactionHash) {
          const result = await rpc.transactionStatus(batch.transactionHash, batch.payerId);
          if (hasFailure(result.status)) {
            batch = transition(batch, "failed", {
              error: `Registration transaction ${batch.transactionHash} failed on-chain`
            });
          } else if (hasSuccess(result.status)) {
            batch = transition(batch, "success", { error: undefined });
          }
        } else {
          const missing = await verifyRegisteredRecipients(rpc, batch.tokenContract, batch.recipientIds);
          batch = missing.length === 0
            ? transition(batch, "success", { error: undefined })
            : transition(batch, "failed", {
              error: `${missing.length} of ${batch.recipientIds.length} recipients are not registered; retrying is safe (already-registered accounts are refunded)`
            });
        }
      } catch (error) {
        batch = {
          ...batch,
          error: error instanceof Error ? error.message : "Registration reconciliation failed",
          updatedAt: Date.now()
        };
      }

      session.batches[index] = batch;
      session.status = session.batches.every((item) => item.status === "success") ? "completed" : "paused";
      session.updatedAt = Date.now();
      await store.putRegistration(session);
    }

    return session;
  }, locks);
}

export async function verifyRegisteredRecipients(
  rpc: NearRpcClient,
  tokenContract: string,
  recipientIds: readonly string[]
): Promise<string[]> {
  const missing: string[] = [];
  for (const recipientId of recipientIds) {
    const storage = await getStorageBalance(rpc, tokenContract, recipientId);
    if (storage === null || storage.total === "0") missing.push(recipientId);
  }
  return missing;
}
