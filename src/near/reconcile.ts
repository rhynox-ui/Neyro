import { createNearConnection } from "./client.js";

export type TransactionReconciliation =
  | { status: "confirmed"; transactionHash: string }
  | { status: "failed"; transactionHash: string; error: string }
  | { status: "unknown"; transactionHash: string; error: string };

export function hasFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasFailure);

  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "Failure")) return true;

  return Object.values(record).some((item) =>
    item && typeof item === "object" ? hasFailure(item) : false
  );
}

export function classifyNearTransactionResult(
  status: unknown,
  receiptsOutcome: unknown
): "confirmed" | "failed" | "unknown" {
  if (hasFailure(status) || hasFailure(receiptsOutcome)) return "failed";

  if (
    status &&
    typeof status === "object" &&
    (
      Object.prototype.hasOwnProperty.call(status, "SuccessValue") ||
      Object.prototype.hasOwnProperty.call(status, "SuccessReceiptId")
    )
  ) {
    return "confirmed";
  }

  return "unknown";
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

    const classification = classifyNearTransactionResult(
      result.status,
      result.receipts_outcome
    );

    if (classification === "failed") {
      return {
        status: "failed",
        transactionHash,
        error: "NEAR execution contains a failed receipt"
      };
    }

    if (classification === "confirmed") {
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
