import { createHash } from "node:crypto";
import { baseEncode, type SignedTransaction } from "near-api-js";
import {
  CostOverflowError,
  InvalidChainError,
  InvalidNonceError,
  InvalidReceiverIdError,
  InvalidSignatureError,
  InvalidSignerIdError,
  InvalidTransactionError,
  NonceTooLargeError,
  NotEnoughBalanceError,
  ShardCongestedError,
  SignerDoesNotExistError,
  TransactionExpiredError,
  TransactionSizeExceededError
} from "near-api-js/rpc-errors";

/** NEAR transaction hash: base58(sha256(borsh(transaction))). */
export function transactionHash(signed: SignedTransaction): string {
  return baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
}

type OutcomeStatus = unknown;

type OutcomeLike = {
  status?: OutcomeStatus;
  receipts_outcome?: Array<{ id?: string; outcome?: { status?: OutcomeStatus } }>;
};

function failureOf(status: OutcomeStatus): unknown {
  if (status && typeof status === "object" && "Failure" in status) {
    return (status as { Failure: unknown }).Failure ?? "Failure";
  }
  return undefined;
}

/**
 * Returns a short description of the first failure in a final execution
 * outcome, including receipt-level failures.
 *
 * A NEAR swap is usually ft_transfer_call → DEX → ft_resolve_transfer. When
 * the DEX receipt fails the tokens are refunded and the top-level transaction
 * status can still be SuccessValue, so the top-level status alone is not
 * proof of a fill.
 */
export function findExecutionFailure(outcome: unknown): string | undefined {
  if (!outcome || typeof outcome !== "object") return "Missing execution outcome";
  const { status, receipts_outcome: receipts = [] } = outcome as OutcomeLike;

  const top = failureOf(status);
  if (top !== undefined) return describe(top);

  for (const receipt of receipts) {
    const failure = failureOf(receipt.outcome?.status);
    if (failure !== undefined) return describe(failure);
  }

  return undefined;
}

function describe(failure: unknown): string {
  const text = typeof failure === "string" ? failure : JSON.stringify(failure);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const DEFINITIVE_REJECTIONS = [
  InvalidTransactionError,
  InvalidNonceError,
  NonceTooLargeError,
  InvalidSignerIdError,
  SignerDoesNotExistError,
  InvalidReceiverIdError,
  InvalidSignatureError,
  NotEnoughBalanceError,
  CostOverflowError,
  InvalidChainError,
  TransactionExpiredError,
  TransactionSizeExceededError,
  ShardCongestedError
];

/**
 * True when the RPC rejected the transaction before execution, so it can
 * never land on chain. Anything else after a broadcast attempt (timeouts,
 * network errors, 5xx) must be treated as an unknown outcome.
 */
export function isDefinitiveRejection(error: unknown): boolean {
  return DEFINITIVE_REJECTIONS.some((type) => error instanceof type);
}
