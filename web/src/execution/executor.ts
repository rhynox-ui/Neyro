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
      batches
    };
    await input.store.put(campaign);
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
    campaign.batches[index] = transitionBatch(campaign.batches[index], "signing");
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


export async function reconcileCampaign(
  campaignId: string,
  store: CampaignStore,
  rpc: NearRpcClient,
  onProgress?: (progress: ExecutionProgress) => void
): Promise<Campaign> {
  const campaign = await store.get(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} was not found`);

  for (let index = 0; index < campaign.batches.length; index += 1) {
    const batch = campaign.batches[index];
    if (
      (batch.status !== "unknown" && batch.status !== "submitted") ||
      !batch.transactionHash
    ) {
      continue;
    }

    try {
      const result = await rpc.transactionStatus(
        batch.transactionHash,
        batch.senderId
      );

      if (hasFailure(result.status)) {
        campaign.batches[index] = transitionBatch(
          batch,
          "failed",
          { error: `Transaction ${batch.transactionHash} failed on-chain` }
        );
      } else if (hasSuccess(result.status)) {
        campaign.batches[index] = transitionBatch(
          batch,
          "success",
          { error: undefined }
        );
      }
    } catch (error) {
      campaign.batches[index] = {
        ...batch,
        error: error instanceof Error ? error.message : "Reconciliation failed",
        updatedAt: Date.now()
      };
    }

    campaign.status = campaignIsComplete(campaign) ? "completed" : "paused";
    await store.put(campaign);
    onProgress?.({ campaign, batch: campaign.batches[index] });
  }

  return campaign;
}
