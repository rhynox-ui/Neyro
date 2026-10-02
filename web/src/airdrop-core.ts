export interface ValidRecipient {
  line: number;
  wallet: string;
  amountBase: bigint;
}

export function parseAmount(value: string, decimals: number): bigint {
  const clean = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(clean)) throw new Error('invalid amount');
  const [whole, fraction = ''] = clean.split('.');
  if (fraction.length > decimals) throw new Error('too many decimals');
  const base = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (base <= 0n) throw new Error('amount must be greater than zero');
  return base;
}

export function allocateRecipients(recipients: readonly ValidRecipient[], senderBalances: ReadonlyMap<string, bigint>): Map<string, ValidRecipient[]> {
  const remaining = new Map(senderBalances);
  const result = new Map<string, ValidRecipient[]>();
  for (const recipient of recipients) {
    let selected: string | undefined;
    for (const [sender, balance] of remaining) {
      if (balance >= recipient.amountBase) { selected = sender; break; }
    }
    if (!selected) throw new Error('insufficient sender balance for recipient allocation');
    remaining.set(selected, remaining.get(selected)! - recipient.amountBase);
    const bucket = result.get(selected) ?? [];
    bucket.push(recipient);
    result.set(selected, bucket);
  }
  return result;
}

export function batchRecipients(recipients: readonly ValidRecipient[], maxActions = 100): ValidRecipient[][] {
  if (!Number.isInteger(maxActions) || maxActions < 1) throw new Error('maxActions must be positive');
  const batches: ValidRecipient[][] = [];
  for (let i = 0; i < recipients.length; i += maxActions) batches.push(recipients.slice(i, i + maxActions));
  return batches;
}
