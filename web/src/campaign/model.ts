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

export type CampaignBatch = {
  id: string;
  senderId: string;
  recipientWallets: string[];
  totalAmount: string;
  actionCount: number;
  status: BatchStatus;
  transactionHash?: string;
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
  patch: Partial<Pick<CampaignBatch, "transactionHash" | "error">> = {},
  now = Date.now()
): CampaignBatch {
  if (!canTransitionBatch(batch.status, status)) {
    throw new Error(`Invalid batch transition: ${batch.status} -> ${status}`);
  }

  return {
    ...batch,
    ...patch,
    status,
    updatedAt: now
  };
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
