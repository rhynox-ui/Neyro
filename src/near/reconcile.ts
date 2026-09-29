import { createNearConnection } from "./client.js";

export type TransactionReconciliation =
  | { status: "confirmed"; transactionHash: string }
  | { status: "failed"; transactionHash: string; error: string }
  | { status: "unknown"; transactionHash: string; error: string };

function hasFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasFailure);

  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "Failure")) return true;

  return Object.values(record).some((item) =>
    item && typeof item === "object" ? hasFailure(item) : false
  );
}

export async function reconcileNearTransaction(
  transactionHash: string,
  signerAccountId: string
): Promise<TransactionReconciliation> {
  try {
    const result = await createNearConnection().provider.sendJsonRpc("tx", [
      transactionHash,
      signerAccountId
    ]) as {
      status?: unknown;
      receipts_outcome?: unknown;
    };

    if (hasFailure(result.status) || hasFailure(result.receipts_outcome)) {
      return {
        status: "failed",
        transactionHash,
        error: "NEAR execution contains a failed receipt"
      };
    }

    const status = result.status;
    if (
      status &&
      typeof status === "object" &&
      (
        Object.prototype.hasOwnProperty.call(status, "SuccessValue") ||
        Object.prototype.hasOwnProperty.call(status, "SuccessReceiptId")
      )
    ) {
      return { status: "confirmed", transactionHash };
    }

    return {
      status: "unknown",
      transactionHash,
      error: "NEAR returned an unrecognized transaction status"
    };
  } catch (error) {
    return {
      status: "unknown",
      transactionHash,
      error: error instanceof Error ? error.message : "transaction lookup failed"
    };
  }
}
