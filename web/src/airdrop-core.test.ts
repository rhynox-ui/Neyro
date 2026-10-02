import { describe, expect, test } from 'vitest';
import { allocateRecipients, batchRecipients, parseAmount } from './airdrop-core';

describe('airdrop core', () => {
  test('uses exact base-unit arithmetic', () => {
    expect(parseAmount('1.25', 2)).toBe(125n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
  });

  test('rejects excess precision', () => {
    expect(() => parseAmount('1.001', 2)).toThrow('too many decimals');
  });

  test('batches at the configured action limit', () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ line: i + 1, wallet: 'w' + i, amountBase: 1n }));
    const batches = batchRecipients(rows);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(100);
    expect(batches[2]).toHaveLength(1);
  });

  test('allocates recipients deterministically', () => {
    const rows = [
      { line: 1, wallet: 'a.near', amountBase: 6n },
      { line: 2, wallet: 'b.near', amountBase: 4n },
      { line: 3, wallet: 'c.near', amountBase: 5n }
    ];
    const balances = new Map([['sender-a.near', 10n], ['sender-b.near', 5n]]);
    const allocation = allocateRecipients(rows, balances);
    expect(allocation.get('sender-a.near')?.map((r) => r.wallet)).toEqual(['a.near', 'b.near']);
    expect(allocation.get('sender-b.near')?.map((r) => r.wallet)).toEqual(['c.near']);
  });
});
