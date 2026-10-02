export type CampaignResultRow = {
  campaignId: string;
  batchId: string;
  senderId: string;
  wallet: string;
  amountBase: string;
  batchStatus: string;
  transactionHash: string;
  error: string;
};

function csvCell(value: string): string {
  return /[",\n\r]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

export function campaignResultsCsv(campaign: {
  id: string;
  batches: Array<{
    id: string;
    senderId: string;
    status: string;
    transactionHash?: string;
    error?: string;
    recipients: Array<{ wallet: string; amountBase: string }>;
  }>;
}): string {
  const header = [
    "campaign_id",
    "batch_id",
    "sender_id",
    "wallet",
    "amount_base",
    "batch_status",
    "transaction_hash",
    "error"
  ];

  const rows = [header];
  for (const batch of campaign.batches) {
    for (const recipient of batch.recipients) {
      rows.push([
        campaign.id,
        batch.id,
        batch.senderId,
        recipient.wallet,
        recipient.amountBase,
        batch.status,
        batch.transactionHash ?? "",
        batch.error ?? ""
      ]);
    }
  }

  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
