import { describe, expect, it } from "vitest";
import {
  canRetryBatch,
  canTransitionBatch,
  campaignIsComplete,
  transitionBatch,
  type Campaign,
  type CampaignBatch
} from "./model";

const baseBatch: CampaignBatch = {
  id: "sender.near:0",
  senderId: "sender.near",
  recipientWallets: ["alice.near"],
  recipients: [{ wallet: "alice.near", amountBase: "100" }],
  totalAmount: "100",
  actionCount: 1,
  status: "pending",
  updatedAt: 1
};

describe("campaign safety state machine", () => {
  it("allows the expected signing path", () => {
    expect(canTransitionBatch("pending", "signing")).toBe(true);
    expect(canTransitionBatch("signing", "submitted")).toBe(true);
    expect(canTransitionBatch("submitted", "success")).toBe(true);
  });

  it("blocks unsafe transitions", () => {
    expect(canTransitionBatch("success", "pending")).toBe(false);
    expect(canTransitionBatch("unknown", "pending")).toBe(false);
  });

  it("requires reconciliation before retrying an unknown broadcast", () => {
    expect(canRetryBatch({ ...baseBatch, status: "failed" })).toBe(true);
    expect(canRetryBatch({ ...baseBatch, status: "unknown" })).toBe(false);
  });

  it("records transaction hashes when a batch is submitted", () => {
    const signing = transitionBatch(baseBatch, "signing", {}, 2);
    const submitted = transitionBatch(
      signing,
      "submitted",
      { transactionHash: "hash-1" },
      3
    );

    expect(submitted.transactionHash).toBe("hash-1");
    expect(submitted.updatedAt).toBe(3);
  });

  it("only reports a campaign complete when every batch succeeds", () => {
    const campaign: Campaign = {
      id: "campaign-1",
      sourceFingerprint: "sha256:test",
      tokenContract: "token.near",
      decimals: 24,
      senderIds: ["sender.near"],
      recipientCount: 1,
      totalAmount: "100",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      batches: [
        { ...baseBatch, status: "success" }
      ]
    };

    expect(campaignIsComplete(campaign)).toBe(true);
    expect(
      campaignIsComplete({
        ...campaign,
        batches: [{ ...baseBatch, status: "unknown" }]
      })
    ).toBe(false);
  });
});
