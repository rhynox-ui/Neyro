import type { ServiceFee, BatchStatus } from "../campaign/model";
import { canTransitionBatch } from "../campaign/model";
import type { NearRpcClient, TxStatusResult } from "../near/rpc";
import { WalletPopupBlockedError, type SignAndSendRequest, type WebWalletConnector } from "../wallet/connector";
import { TOKEN_TOOL_FEE_RECIPIENT } from "../token-tools/fee-recipient";
import { getAirdropFee } from "../token-tools/fees";
import { captureSigningEvidence, checkNotExecuted } from "./signing-evidence";

/** Pseudo batch id used by the UI and hash attachment for the fee row. */
export const SERVICE_FEE_ID = "service-fee";

// Margin for the transfer's own gas on top of the fee.
const FEE_GAS_MARGIN = 1_000_000_000_000_000_000_000n; // 0.001 NEAR
const STORAGE_PRICE_PER_BYTE = 10_000_000_000_000_000_000n;

export function newAirdropServiceFee(payerId: string, recipientCount: number): ServiceFee {
  return {
    payerId,
    receiverId: TOKEN_TOOL_FEE_RECIPIENT,
    amount: getAirdropFee(recipientCount).toString(),
    status: "pending",
    updatedAt: Date.now()
  };
}

export function transitionFee(
  fee: ServiceFee,
  status: BatchStatus,
  patch: Partial<Pick<ServiceFee, "transactionHash" | "error" | "signingEvidence">> = {}
): ServiceFee {
  if (!canTransitionBatch(fee.status, status)) {
    throw new Error(`Invalid service fee transition: ${fee.status} -> ${status}`);
  }
  const next: ServiceFee = { ...fee, ...patch, status, updatedAt: Date.now() };
  if (fee.status === "failed" && status === "pending") {
    if (fee.transactionHash) {
      next.previousTransactionHashes = [...(fee.previousTransactionHashes ?? []), fee.transactionHash];
    }
    delete next.transactionHash;
    delete next.signingEvidence;
  }
  return next;
}

export function buildServiceFeeTransaction(fee: ServiceFee): SignAndSendRequest {
  return {
    signerId: fee.payerId,
    receiverId: fee.receiverId,
    actions: [{ type: "Transfer", receiverId: fee.receiverId, deposit: BigInt(fee.amount) }]
  };
}

function finalStatus(result: TxStatusResult): "success" | "failed" | null {
  const status = result.status;
  if (status && typeof status === "object") {
    if ("Failure" in status) return "failed";
    if ("SuccessValue" in status || "SuccessReceiptId" in status) return "success";
  }
  return null;
}

/** Checks that an on-chain transaction is exactly this fee payment. */
export function transactionMatchesFee(
  result: TxStatusResult,
  fee: ServiceFee
): { matches: true } | { matches: false; reason: string } {
  const tx = result.transaction as
    | { signer_id?: unknown; receiver_id?: unknown; actions?: unknown }
    | undefined;
  if (!tx) return { matches: false, reason: "RPC response did not include the transaction body" };
  if (tx.signer_id !== fee.payerId) return { matches: false, reason: `Signer is not ${fee.payerId}` };
  if (tx.receiver_id !== fee.receiverId) return { matches: false, reason: `Receiver is not ${fee.receiverId}` };
  const actions = Array.isArray(tx.actions) ? tx.actions : [];
  const transfer = (actions[0] as { Transfer?: { deposit?: unknown } } | undefined)?.Transfer;
  if (actions.length !== 1 || !transfer || String(transfer.deposit) !== fee.amount) {
    return { matches: false, reason: `Transaction is not a single ${fee.amount} yoctoNEAR transfer` };
  }
  return { matches: true };
}

/**
 * Pays the fee once. `save` must persist the fee before the wallet opens so a
 * reload never loses the fact that a payment may have been signed.
 */
export async function payServiceFee(
  fee: ServiceFee,
  wallet: WebWalletConnector,
  rpc: NearRpcClient,
  save: (fee: ServiceFee) => Promise<void>
): Promise<ServiceFee> {
  if (fee.status === "success") return fee;
  if (fee.status !== "pending" && fee.status !== "failed") {
    throw new Error("The Neyro service fee needs reconciliation before execution can continue");
  }

  const accounts = await wallet.getAccounts();
  if (!accounts.some((account) => account.accountId === fee.payerId)) {
    throw new Error(`Connect ${fee.payerId} in the browser wallet to pay the Neyro service fee`);
  }
  const account = await rpc.viewAccount(fee.payerId);
  const locked = BigInt(account.storage_usage) * STORAGE_PRICE_PER_BYTE;
  const spendable = BigInt(account.amount) - locked;
  if (spendable < BigInt(fee.amount) + FEE_GAS_MARGIN) {
    throw new Error(`${fee.payerId} does not have enough NEAR to pay the Neyro service fee`);
  }

  let current = fee.status === "failed" ? transitionFee(fee, "pending") : fee;
  const signingEvidence = await captureSigningEvidence(rpc, fee.payerId);
  current = transitionFee(current, "signing", { signingEvidence, error: undefined });
  await save(current);

  let hash: string | undefined;
  try {
    hash = (await wallet.signAndSend(buildServiceFeeTransaction(current))).transactionHash;
  } catch (error) {
    if (error instanceof WalletPopupBlockedError) {
      current = transitionFee(current, "failed", { error: error.message });
      await save(current);
      throw error;
    }
    current = transitionFee(current, "unknown", {
      error: error instanceof Error ? error.message : "Wallet result unknown"
    });
    await save(current);
    throw error;
  }
  if (!hash) {
    current = transitionFee(current, "unknown", { error: "Wallet returned without a transaction hash" });
    await save(current);
    throw new Error("Fee payment result is unknown; reconcile before continuing");
  }

  current = transitionFee(current, "submitted", { transactionHash: hash, error: undefined });
  await save(current);
  return reconcileServiceFee(current, rpc).then(async (resolved) => {
    await save(resolved);
    if (resolved.status !== "success") {
      throw new Error(resolved.error ?? "Fee payment did not confirm");
    }
    return resolved;
  });
}

/** Resolves an unresolved fee from chain state; never re-sends it. */
export async function reconcileServiceFee(fee: ServiceFee, rpc: NearRpcClient): Promise<ServiceFee> {
  let current = fee;
  if (current.status === "signing") {
    current = transitionFee(current, "unknown", {
      error: "Signing was interrupted before the wallet returned a transaction hash"
    });
  }
  if (current.status !== "unknown" && current.status !== "submitted") return current;

  try {
    if (current.transactionHash) {
      const outcome = finalStatus(await rpc.transactionStatus(current.transactionHash, current.payerId));
      if (outcome === "success") return transitionFee(current, "success", { error: undefined });
      if (outcome === "failed") {
        return transitionFee(current, "failed", { error: `Fee transaction ${current.transactionHash} failed on-chain` });
      }
      return { ...current, error: "Fee transaction is not final yet", updatedAt: Date.now() };
    }
    if (!current.signingEvidence) {
      return { ...current, error: "Supply the fee transaction hash to reconcile it", updatedAt: Date.now() };
    }
    const check = await checkNotExecuted(rpc, current.payerId, current.signingEvidence);
    return check.proven
      ? transitionFee(current, "failed", { error: "Proven not executed; the fee can be paid again" })
      : { ...current, error: check.reason, updatedAt: Date.now() };
  } catch (error) {
    return {
      ...current,
      error: error instanceof Error ? error.message : "Fee reconciliation failed",
      updatedAt: Date.now()
    };
  }
}

/** Binds a user-supplied hash to a hashless unresolved fee after verifying it. */
export async function attachFeeTransactionHash(
  fee: ServiceFee,
  hash: string,
  rpc: NearRpcClient
): Promise<ServiceFee> {
  let current = fee.status === "signing"
    ? transitionFee(fee, "unknown", { error: "Signing was interrupted" })
    : fee;
  if (current.status !== "unknown" || current.transactionHash) {
    throw new Error("The service fee is not an unresolved payment without a hash");
  }
  const result = await rpc.transactionStatus(hash, current.payerId);
  const match = transactionMatchesFee(result, current);
  if (!match.matches) throw new Error(`Transaction ${hash} is not this fee payment: ${match.reason}`);
  current = transitionFee(current, "submitted", { transactionHash: hash, error: undefined });
  const outcome = finalStatus(result);
  if (outcome === "success") return transitionFee(current, "success", { error: undefined });
  if (outcome === "failed") return transitionFee(current, "failed", { error: `Fee transaction ${hash} failed on-chain` });
  return current;
}
