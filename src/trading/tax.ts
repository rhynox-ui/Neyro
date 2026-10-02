/** NEARly immutable tax arithmetic. All values are integer base units. */
export const MAX_TAX_BPS = 400;

export function assertTaxBps(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_TAX_BPS) {
    throw new Error("Invalid NEARly tax basis points");
  }
  return bps;
}

/** Tokens actually received after a buy tax is applied to the Rhea output. */
export function applyBuyTax(amount: bigint, taxBps: number): bigint {
  assertTaxBps(taxBps);
  return (amount * BigInt(10_000 - taxBps)) / 10_000n;
}

/** Tokens that reach Rhea after a sell tax is taken from the wallet transfer. */
export function applySellTax(amount: bigint, taxBps: number): bigint {
  assertTaxBps(taxBps);
  return (amount * BigInt(10_000 - taxBps)) / 10_000n;
}
