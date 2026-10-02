export type SenderBalance = {
  senderId: string;
  tokenBalance: bigint;
  nativeBalance: bigint;
};

export type Allocation = {
  senderId: string;
  recipients: ValidRecipient[];
  totalAmount: bigint;
};

export interface ValidRecipient {
  line: number;
  wallet: string;
  amountBase: bigint;
}

export function parseAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24) {
    throw new Error("decimals must be an integer between 0 and 24");
  }
  const clean = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(clean)) throw new Error("invalid amount");
  const [whole, fraction = ""] = clean.split(".");
  if (fraction.length > decimals) throw new Error("too many decimals");
  const base =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (base <= 0n) throw new Error("amount must be greater than zero");
  return base;
}

export function allocateRecipients(
  recipients: readonly ValidRecipient[],
  senderBalances: ReadonlyMap<string, bigint>
): Map<string, ValidRecipient[]> {
  const allocations = allocateRecipientsDetailed(
    recipients,
    Array.from(senderBalances, ([senderId, tokenBalance]) => ({
      senderId,
      tokenBalance,
      nativeBalance: 0n
    }))
  );
  return new Map(allocations.map((allocation) => [allocation.senderId, allocation.recipients]));
}

export function allocateRecipientsDetailed(
  recipients: readonly ValidRecipient[],
  senders: readonly SenderBalance[]
): Allocation[] {
  const remaining = new Map<string, bigint>();
  for (const sender of senders) {
    if (!sender.senderId) throw new Error("sender id is required");
    if (sender.tokenBalance < 0n || sender.nativeBalance < 0n) {
      throw new Error("sender balances cannot be negative");
    }
    if (remaining.has(sender.senderId)) throw new Error("duplicate sender id");
    remaining.set(sender.senderId, sender.tokenBalance);
  }

  const totalRequired = recipients.reduce((sum, recipient) => sum + recipient.amountBase, 0n);
  const totalAvailable = senders.reduce((sum, sender) => sum + sender.tokenBalance, 0n);
  if (totalAvailable < totalRequired) {
    throw new Error("insufficient total sender token balance");
  }

  // Best-fit decreasing reduces fragmentation while remaining deterministic:
  // larger transfers are placed first, and ties preserve source order.
  const orderedRecipients = recipients
    .map((recipient, index) => ({ recipient, index }))
    .sort((a, b) =>
      b.recipient.amountBase === a.recipient.amountBase
        ? a.index - b.index
        : b.recipient.amountBase > a.recipient.amountBase ? 1 : -1
    )
    .map(({ recipient }) => recipient);

  const result = new Map<string, ValidRecipient[]>();
  for (const recipient of orderedRecipients) {
    let selected: string | undefined;
    let selectedRemaining: bigint | undefined;

    for (const [sender, balance] of remaining) {
      if (balance >= recipient.amountBase &&
          (selectedRemaining === undefined || balance < selectedRemaining)) {
        selected = sender;
        selectedRemaining = balance;
      }
    }

    if (!selected) {
      throw new Error("sender balances cannot satisfy recipient allocation");
    }

    remaining.set(selected, remaining.get(selected)! - recipient.amountBase);
    const bucket = result.get(selected) ?? [];
    bucket.push(recipient);
    result.set(selected, bucket);
  }

  return senders
    .map((sender) => ({
      senderId: sender.senderId,
      recipients: result.get(sender.senderId) ?? [],
      totalAmount: (result.get(sender.senderId) ?? []).reduce(
        (sum, recipient) => sum + recipient.amountBase,
        0n
      )
    }))
    .filter((allocation) => allocation.recipients.length > 0);
}

export function batchRecipients(
  recipients: readonly ValidRecipient[],
  maxActions = 100
): ValidRecipient[][] {
  if (!Number.isInteger(maxActions) || maxActions < 1) {
    throw new Error("maxActions must be positive");
  }
  const batches: ValidRecipient[][] = [];
  for (let i = 0; i < recipients.length; i += maxActions) {
    batches.push(recipients.slice(i, i + maxActions));
  }
  return batches;
}
