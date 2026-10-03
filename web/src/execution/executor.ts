import type { Allocation } from "../airdrop-core";
import {
  buildFtTransferAction,
  buildTransferBatches,
  DEFAULT_MAX_ACTIONS,
  DEFAULT_PREPAID_GAS,
  YOCTONEAR,
  type TransferBatch
} from "../airdrop/batch-builder";
import { getFtBalance, getStorageBalance, isRegistered } from "../near/ft";
import type { NearRpcClient } from "../near/rpc";
import type { Campaign, CampaignBatch } from "../campaign/model";
import { campaignIsComplete, transitionBatch } from "../campaign/model";
import type { CampaignStore } from "../campaign/storage";
import { campaignIdFromFingerprint } from "../campaign/storage";
import { buildAirdropTransaction } from "./transaction-builder";
import type { WebWalletConnector } from "../wallet/connector";
import { withCampaignLock } from "./campaign-lock";
import {
  attachFeeTransactionHash,
  newAirdropServiceFee,
  payServiceFee,
  reconcileServiceFee,
  SERVICE_FEE_ID
} from "./service-fee";
import {
  captureSigningEvidence,
  checkNotExecuted,
  transactionMatchesBatch
} from "./signing-evidence";

export type ExecutionProgress = {
  batch: CampaignBatch;
  campaign: Campaign;
};

export type AirdropExecutionInput = {
  tokenContract: string;
  decimals: number;
  allocations: readonly Allocation[];
  sourceFingerprint: string;
  wallet: WebWalletConnector;
  rpc: NearRpcClient;
  store: CampaignStore;
  maxActions?: number;
  onProgress?: (progress: ExecutionProgress) => void;
  /** Cross-tab lock manager; defaults to `navigator.locks`. */
  locks?: LockManager;
};

export type ExecutionResult = {
  campaign: Campaign;
  campaignId: string;
};

function buildCampaignBatches(
  allocations: readonly Allocation[],
  maxActions: number,
  now: number
): CampaignBatch[] {
  const batches: CampaignBatch[] = [];

  for (const allocation of allocations) {
    if (allocation.recipients.length === 0) continue;

    const transferBatches = buildTransferBatches(
      allocation.senderId,
      allocation.recipients,
      maxActions
    );

    for (const batch of transferBatches) {
      batches.push({
        id: batch.batchId,
        senderId: batch.senderId,
        recipientWallets: batch.actions.map((action) => action.args.receiverId),
        recipients: batch.actions.map((action) => ({
          wallet: action.args.receiverId,
          amountBase: action.args.amount
        })),
        totalAmount: batch.totalAmount.toString(),
        actionCount: batch.actions.length,
        status: "pending",
        updatedAt: now
      });
    }
  }

  return batches;
}

function batchToTransferBatch(batch: CampaignBatch): TransferBatch {
  if (batch.recipients.length !== batch.actionCount) {
    throw new Error(`Campaign batch ${batch.id} has incomplete recipient data`);
  }

  const actions = batch.recipients.map((recipient) =>
    buildFtTransferAction(recipient.wallet, BigInt(recipient.amountBase))
  );

  return {
    batchId: batch.id,
    senderId: batch.senderId,
    actions,
    totalAmount: actions.reduce(
      (total, action) => total + BigInt(action.args.amount),
      0n
    ),
    totalPrepaidGas: actions.reduce(
      (total, action) => total + action.gas,
      0n
    )
  };
}

function hasSuccess(status: unknown): boolean {
  return Boolean(
    status &&
      typeof status === "object" &&
      ("SuccessValue" in status || "SuccessReceiptId" in status)
  );
}

function hasFailure(status: unknown): boolean {
  return Boolean(
    status &&
      typeof status === "object" &&
      "Failure" in status
  );
}

function assertPositiveIntegerString(value: string, label: string): void {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${label} must be a positive integer`);
  }
}

async function waitForFinalSuccess(
  rpc: NearRpcClient,
  hash: string,
  senderId: string
): Promise<void> {
  const result = await rpc.transactionStatus(hash, senderId);
  if (hasFailure(result.status)) {
    throw new Error(`Transaction ${hash} failed on-chain`);
  }
  if (!hasSuccess(result.status)) {
    throw new Error(`Transaction ${hash} did not reach a final success state`);
  }
}

async function freshSenderCheck(
  rpc: NearRpcClient,
  tokenContract: string,
  batch: CampaignBatch
): Promise<void> {
  const [tokenBalance, storage, account, gasPrice] = await Promise.all([
    getFtBalance(rpc, tokenContract, batch.senderId),
    getStorageBalance(rpc, tokenContract, batch.senderId),
    rpc.viewAccount(batch.senderId),
    rpc.gasPrice()
  ]);

  if (storage !== null && !isRegistered(storage)) {
    throw new Error(
      `Sender ${batch.senderId} is not registered with ${tokenContract}`
    );
  }

  const required = BigInt(batch.totalAmount);
  if (tokenBalance < required) {
    throw new Error(
      `Sender ${batch.senderId} has insufficient token balance for batch ${batch.id}`
    );
  }

  const maximumGasCost =
    BigInt(batch.actionCount) * DEFAULT_PREPAID_GAS * gasPrice +
    BigInt(batch.actionCount) * YOCTONEAR;

  if (BigInt(account.amount) < maximumGasCost) {
    throw new Error(
      `Sender ${batch.senderId} does not have enough native NEAR for the batch gas budget`
    );
  }
}

async function persist(
  store: CampaignStore,
  campaign: Campaign,
  onProgress?: (progress: ExecutionProgress) => void
): Promise<void> {
  campaign.updatedAt = Date.now();
  await store.put(campaign);
  onProgress?.({
    campaign,
    batch: campaign.batches.find((batch) => batch.status === "signing") ??
      campaign.batches.find((batch) => batch.status === "submitted") ??
      campaign.batches.find((batch) => batch.status === "success") ??
      campaign.batches[campaign.batches.length - 1]
  });
}

export async function executeAirdrop(
  input: AirdropExecutionInput
): Promise<ExecutionResult> {
  if (!input.tokenContract.trim()) throw new Error("token contract is required");
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 24) {
    throw new Error("decimals must be an integer between 0 and 24");
  }
  if (input.allocations.length === 0) throw new Error("no sender allocations were produced");

  const maxActions = input.maxActions ?? DEFAULT_MAX_ACTIONS;
  const now = Date.now();
  const batches = buildCampaignBatches(input.allocations, maxActions, now);
  if (batches.length === 0) throw new Error("no transfer batches were produced");

  const totalAmount = input.allocations
    .reduce((sum, allocation) => sum + allocation.totalAmount, 0n);

  const campaignId = await campaignIdFromFingerprint(input.sourceFingerprint);
  return withCampaignLock(
    campaignId,
    () => executeLocked(input, campaignId, batches, totalAmount, now),
    input.locks
  );
}

async function executeLocked(
  input: AirdropExecutionInput,
  campaignId: string,
  batches: CampaignBatch[],
  totalAmount: bigint,
  now: number
): Promise<ExecutionResult> {
  let campaign = await input.store.get(campaignId);

  if (campaign) {
    if (
      campaign.tokenContract !== input.tokenContract ||
      campaign.decimals !== input.decimals ||
      campaign.sourceFingerprint !== input.sourceFingerprint
    ) {
      throw new Error("existing campaign fingerprint does not match this execution request");
    }
  } else {
    campaign = {
      id: campaignId,
      sourceFingerprint: input.sourceFingerprint,
      tokenContract: input.tokenContract,
      decimals: input.decimals,
      senderIds: input.allocations.map((allocation) => allocation.senderId),
      recipientCount: batches.reduce((sum, batch) => sum + batch.actionCount, 0),
      totalAmount: totalAmount.toString(),
      status: "planned",
      createdAt: now,
      updatedAt: now,
      batches,
      serviceFee: newAirdropServiceFee(
        batches[0].senderId,
        batches.reduce((sum, batch) => sum + batch.actionCount, 0)
      )
    };
    await input.store.put(campaign);
  }

  // Charged once per campaign, before any token leaves a sender. Campaigns
  // created before fees existed have no serviceFee and are not charged.
  if (campaign.serviceFee && campaign.serviceFee.status !== "success") {
    const owned = campaign;
    try {
      owned.serviceFee = await payServiceFee(
        owned.serviceFee!,
        input.wallet,
        input.rpc,
        async (fee) => {
          owned.serviceFee = fee;
          await persist(input.store, owned, input.onProgress);
        }
      );
    } catch (error) {
      owned.status = "paused";
      await input.store.put(owned);
      throw error;
    }
  }

  for (const batch of campaign.batches) {
    if (batch.status === "success") continue;
    if (batch.status === "unknown" || batch.status === "submitted" || batch.status === "signing") {
      campaign.status = "paused";
      await input.store.put(campaign);
      throw new Error(
        `Batch ${batch.id} needs reconciliation before execution can continue`
      );
    }

    assertPositiveIntegerString(batch.totalAmount, `Batch ${batch.id} total`);

    await freshSenderCheck(input.rpc, input.tokenContract, batch);

    const accounts = await input.wallet.getAccounts();
    if (!accounts.some((account) => account.accountId === batch.senderId)) {
      campaign.status = "paused";
      await input.store.put(campaign);
      throw new Error(
        `Connect sender account ${batch.senderId} in the browser wallet before continuing`
      );
    }

    campaign.status = "running";
    const index = campaign.batches.findIndex((candidate) => candidate.id === batch.id);
    if (index < 0) throw new Error(`Batch ${batch.id} is missing from campaign state`);

    const current = campaign.batches[index];
    if (current.status === "failed") {
      campaign.batches[index] = transitionBatch(current, "pending");
    }
    // Captured before `signing` is persisted: if it cannot be read, nothing is
    // handed to the wallet and the batch stays pending.
    const signingEvidence = await captureSigningEvidence(input.rpc, batch.senderId);
    campaign.batches[index] = transitionBatch(
      campaign.batches[index],
      "signing",
      { signingEvidence, error: undefined }
    );
    await persist(input.store, campaign, input.onProgress);

    const transferBatch = batchToTransferBatch(batch);
    const request = buildAirdropTransaction(
      batch.senderId,
      input.tokenContract,
      transferBatch
    );

    try {
      const outcome = await input.wallet.signAndSend(request);
      if (!outcome.transactionHash) {
        campaign.batches[index] = transitionBatch(
          campaign.batches[index],
          "unknown",
          { error: "Wallet returned without a transaction hash" }
        );
        campaign.status = "paused";
        await persist(input.store, campaign, input.onProgress);
        throw new Error("Wallet returned without a transaction hash; reconcile before retrying");
      }

      campaign.batches[index] = transitionBatch(
        campaign.batches[index],
        "submitted",
        { transactionHash: outcome.transactionHash, error: undefined }
      );
      await persist(input.store, campaign, input.onProgress);

      await waitForFinalSuccess(
        input.rpc,
        outcome.transactionHash,
        batch.senderId
      );

      campaign.batches[index] = transitionBatch(
        campaign.batches[index],
        "success",
        { transactionHash: outcome.transactionHash, error: undefined }
      );
      campaign.status = campaignIsComplete(campaign) ? "completed" : "running";
      await persist(input.store, campaign, input.onProgress);
    } catch (error) {
      if (campaign.batches[index].status === "submitted") {
        campaign.batches[index] = transitionBatch(
          campaign.batches[index],
          "unknown",
          {
            error: error instanceof Error ? error.message : "Transaction outcome could not be confirmed"
          }
        );
      } else if (campaign.batches[index].status === "signing") {
        campaign.batches[index] = transitionBatch(
          campaign.batches[index],
          "unknown",
          {
            error: error instanceof Error ? error.message : "Wallet execution outcome is unknown"
          }
        );
      }

      campaign.status = "paused";
      await persist(input.store, campaign, input.onProgress);
      throw error;
    }
  }

  campaign.status = campaignIsComplete(campaign) ? "completed" : "paused";
  await input.store.put(campaign);
  return { campaign, campaignId };
}


const INTERRUPTED_SIGNING =
  "Signing was interrupted before the wallet returned a transaction hash";

/** Applies the final on-chain status of a hash-bearing batch, if available. */
async function reconcileHashedBatch(
  rpc: NearRpcClient,
  batch: CampaignBatch
): Promise<CampaignBatch> {
  const hash = batch.transactionHash!;
  try {
    const result = await rpc.transactionStatus(hash, batch.senderId);
    if (hasFailure(result.status)) {
      return transitionBatch(batch, "failed", { error: `Transaction ${hash} failed on-chain` });
    }
    if (hasSuccess(result.status)) {
      return transitionBatch(batch, "success", { error: undefined });
    }
    return { ...batch, error: `Transaction ${hash} is not final yet`, updatedAt: Date.now() };
  } catch (error) {
    return {
      ...batch,
      error: error instanceof Error ? error.message : "Reconciliation failed",
      updatedAt: Date.now()
    };
  }
}

/** Resolves a batch that has no hash only when non-execution is proven. */
async function reconcileHashlessBatch(
  rpc: NearRpcClient,
  batch: CampaignBatch
): Promise<CampaignBatch> {
  if (!batch.signingEvidence) {
    return {
      ...batch,
      error: "No signing evidence was recorded for this attempt; supply its transaction hash to reconcile it",
      updatedAt: Date.now()
    };
  }
  try {
    const check = await checkNotExecuted(rpc, batch.senderId, batch.signingEvidence);
    if (check.proven) {
      return transitionBatch(batch, "failed", {
        error: `Proven not executed: no sender transaction was included through block ${check.checkedAtBlockHeight.toLocaleString()} and the signing window has expired`
      });
    }
    return { ...batch, error: check.reason, updatedAt: Date.now() };
  } catch (error) {
    return {
      ...batch,
      error: error instanceof Error ? error.message : "Non-execution check failed",
      updatedAt: Date.now()
    };
  }
}

export async function reconcileCampaign(
  campaignId: string,
  store: CampaignStore,
  rpc: NearRpcClient,
  onProgress?: (progress: ExecutionProgress) => void,
  locks?: LockManager
): Promise<Campaign> {
  return withCampaignLock(campaignId, async () => {
    const campaign = await store.get(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} was not found`);

    if (campaign.serviceFee && campaign.serviceFee.status !== "success") {
      campaign.serviceFee = await reconcileServiceFee(campaign.serviceFee, rpc);
      campaign.updatedAt = Date.now();
      await store.put(campaign);
    }

    for (let index = 0; index < campaign.batches.length; index += 1) {
      let batch = campaign.batches[index];

      // Holding the campaign lock means no tab is currently signing, so a
      // persisted `signing` batch is an interrupted attempt.
      if (batch.status === "signing") {
        batch = transitionBatch(batch, "unknown", { error: INTERRUPTED_SIGNING });
      }

      if (batch.status === "submitted" || batch.status === "unknown") {
        batch = batch.transactionHash
          ? await reconcileHashedBatch(rpc, batch)
          : await reconcileHashlessBatch(rpc, batch);
      } else {
        continue;
      }

      campaign.batches[index] = batch;
      campaign.status = campaignIsComplete(campaign) ? "completed" : "paused";
      campaign.updatedAt = Date.now();
      await store.put(campaign);
      onProgress?.({ campaign, batch });
    }

    return campaign;
  }, locks);
}

/**
 * Binds a user-supplied transaction hash to a hashless unresolved batch, after
 * verifying on-chain that the transaction is exactly that batch's transfers,
 * then records its final status.
 */
export async function attachTransactionHash(
  campaignId: string,
  batchId: string,
  transactionHash: string,
  store: CampaignStore,
  rpc: NearRpcClient,
  locks?: LockManager
): Promise<Campaign> {
  const hash = transactionHash.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash)) {
    throw new Error("Transaction hash must be a base58 NEAR transaction hash");
  }

  return withCampaignLock(campaignId, async () => {
    const campaign = await store.get(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} was not found`);

    const knownHashes = [
      ...campaign.batches.flatMap((item) => [item.transactionHash, ...(item.previousTransactionHashes ?? [])]),
      campaign.serviceFee?.transactionHash,
      ...(campaign.serviceFee?.previousTransactionHashes ?? [])
    ];
    if (knownHashes.includes(hash)) {
      throw new Error(`Transaction ${hash} is already recorded for this campaign`);
    }

    if (batchId === SERVICE_FEE_ID) {
      if (!campaign.serviceFee) throw new Error("This campaign has no service fee");
      campaign.serviceFee = await attachFeeTransactionHash(campaign.serviceFee, hash, rpc);
      campaign.updatedAt = Date.now();
      await store.put(campaign);
      return campaign;
    }

    const index = campaign.batches.findIndex((candidate) => candidate.id === batchId);
    if (index < 0) throw new Error(`Batch ${batchId} is not part of campaign ${campaignId}`);
    let batch = campaign.batches[index];

    if (batch.status === "signing") {
      batch = transitionBatch(batch, "unknown", { error: INTERRUPTED_SIGNING });
    }
    if (batch.status !== "unknown" || batch.transactionHash) {
      throw new Error(`Batch ${batchId} is not an unresolved batch without a transaction hash`);
    }
    const usedElsewhere = campaign.batches.some((candidate) =>
      candidate.transactionHash === hash ||
      candidate.previousTransactionHashes?.includes(hash)
    );
    if (usedElsewhere) {
      throw new Error(`Transaction ${hash} is already recorded for this campaign`);
    }

    const result = await rpc.transactionStatus(hash, batch.senderId);
    const match = transactionMatchesBatch(result, batch, campaign.tokenContract);
    if (!match.matches) {
      throw new Error(`Transaction ${hash} does not match batch ${batchId}: ${match.reason}`);
    }

    batch = transitionBatch(batch, "submitted", { transactionHash: hash, error: undefined });
    if (hasFailure(result.status)) {
      batch = transitionBatch(batch, "failed", { error: `Transaction ${hash} failed on-chain` });
    } else if (hasSuccess(result.status)) {
      batch = transitionBatch(batch, "success", { error: undefined });
    }

    campaign.batches[index] = batch;
    campaign.status = campaignIsComplete(campaign) ? "completed" : "paused";
    campaign.updatedAt = Date.now();
    await store.put(campaign);
    return campaign;
  }, locks);
}
