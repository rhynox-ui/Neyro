import type { SigningEvidence } from "../execution/signing-evidence";

export type BatchStatus =
  | "pending"
  | "signing"
  | "submitted"
  | "success"
  | "failed"
  | "unknown";

export type CampaignStatus =
  | "planned"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type CampaignRecipient = {
  wallet: string;
  amountBase: string;
};

export type CampaignBatch = {
  id: string;
  senderId: string;
  recipientWallets: string[];
  recipients: CampaignRecipient[];
  totalAmount: string;
  actionCount: number;
  status: BatchStatus;
  transactionHash?: string;
  /** Hashes of earlier attempts that were confirmed failed on-chain. */
  previousTransactionHashes?: string[];
  /** Sender chain state captured just before the latest signing attempt. */
  signingEvidence?: SigningEvidence;
  error?: string;
  updatedAt: number;
};

export type Campaign = {
  id: string;
  sourceFingerprint: string;
  tokenContract: string;
  decimals: number;
  senderIds: string[];
  recipientCount: number;
  totalAmount: string;
  status: CampaignStatus;
  createdAt: number;
  updatedAt: number;
  batches: CampaignBatch[];
};

const transitions: Record<BatchStatus, readonly BatchStatus[]> = {
  pending: ["signing", "failed"],
  signing: ["submitted", "failed", "unknown"],
  submitted: ["success", "failed", "unknown"],
  success: [],
  failed: ["pending"],
  unknown: ["submitted", "success", "failed"]
};

export function canTransitionBatch(
  from: BatchStatus,
  to: BatchStatus
): boolean {
  return transitions[from].includes(to);
}

export function transitionBatch(
  batch: CampaignBatch,
  status: BatchStatus,
  patch: Partial<Pick<CampaignBatch, "transactionHash" | "error" | "signingEvidence">> = {},
  now = Date.now()
): CampaignBatch {
  if (!canTransitionBatch(batch.status, status)) {
    throw new Error(`Invalid batch transition: ${batch.status} -> ${status}`);
  }

  const next: CampaignBatch = {
    ...batch,
    ...patch,
    status,
    updatedAt: now
  };

  // A retry starts a new attempt: the old failed hash must not be reconciled
  // as if it described the new signature, or a hashless retry could be
  // misread as failed and resent.
  if (batch.status === "failed" && status === "pending") {
    if (batch.transactionHash) {
      next.previousTransactionHashes = [
        ...(batch.previousTransactionHashes ?? []),
        batch.transactionHash
      ];
    }
    delete next.transactionHash;
    delete next.signingEvidence;
  }

  return next;
}

export function canRetryBatch(batch: CampaignBatch): boolean {
  // Unknown means a broadcast may already exist. It must be reconciled first.
  return batch.status === "failed";
}

export function campaignIsComplete(campaign: Campaign): boolean {
  return (
    campaign.batches.length > 0 &&
    campaign.batches.every((batch) => batch.status === "success")
  );
}
