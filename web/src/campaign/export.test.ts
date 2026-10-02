import { describe, expect, it } from "vitest";
import { campaignResultsCsv } from "./export";

describe("campaign result export", () => {
  it("exports every recipient with persisted execution state", () => {
    const csv = campaignResultsCsv({
      id: "campaign-1",
      batches: [
        {
          id: "batch-1",
          senderId: "sender.near",
          status: "success",
          transactionHash: "tx-1",
          recipients: [
            { wallet: "alice.near", amountBase: "100" },
            { wallet: "bob.near", amountBase: "200" }
          ]
        }
      ]
    });

    expect(csv).toContain("campaign_id,batch_id,sender_id,wallet,amount_base,batch_status,transaction_hash,error");
    expect(csv).toContain("campaign-1,batch-1,sender.near,alice.near,100,success,tx-1,");
    expect(csv).toContain("campaign-1,batch-1,sender.near,bob.near,200,success,tx-1,");
  });

  it("escapes commas, quotes and newlines", () => {
    const csv = campaignResultsCsv({
      id: "campaign,1",
      batches: [
        {
          id: "batch-1",
          senderId: "sender.near",
          status: "failed",
          error: 'failed, "retry"\nnow',
          recipients: [{ wallet: "alice.near", amountBase: "100" }]
        }
      ]
    });

    expect(csv).toContain('"campaign,1"');
    expect(csv).toContain('"failed, ""retry""\nnow"');
  });
});
