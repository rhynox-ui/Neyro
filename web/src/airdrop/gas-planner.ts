export const MAX_ACTIONS_PER_RECEIPT = 100;
export const MAX_TOTAL_PREPAID_GAS = 300_000_000_000_000n; // 300 Tgas
export const DEFAULT_PREPAID_GAS = 30_000_000_000_000n; // 30 Tgas
export const DEFAULT_RESERVED_GAS = 60_000_000_000_000n; // 60 Tgas safety budget

export type GasPlan = {
  gasPerAction: bigint;
  reservedGas: bigint;
  maxActions: number;
  totalPrepaidGas: bigint;
};

export function maxSafeActions(
  gasPerAction = DEFAULT_PREPAID_GAS,
  reservedGas = DEFAULT_RESERVED_GAS
): number {
  if (gasPerAction <= 0n) throw new Error("gasPerAction must be greater than zero");
  if (reservedGas < 0n || reservedGas >= MAX_TOTAL_PREPAID_GAS) {
    throw new Error("reservedGas must be below the transaction gas limit");
  }

  const gasBudget = MAX_TOTAL_PREPAID_GAS - reservedGas;
  const gasLimitedActions = Number(gasBudget / gasPerAction);

  return Math.min(MAX_ACTIONS_PER_RECEIPT, gasLimitedActions);
}

export function planBatchGas(
  actionCount: number,
  gasPerAction = DEFAULT_PREPAID_GAS,
  reservedGas = DEFAULT_RESERVED_GAS
): GasPlan {
  if (!Number.isInteger(actionCount) || actionCount <= 0) {
    throw new Error("actionCount must be a positive integer");
  }

  const maxActions = maxSafeActions(gasPerAction, reservedGas);
  if (actionCount > maxActions) {
    throw new Error(
      `batch requests ${actionCount} actions but only ${maxActions} fit the conservative gas budget`
    );
  }

  const totalPrepaidGas = BigInt(actionCount) * gasPerAction;
  return { gasPerAction, reservedGas, maxActions, totalPrepaidGas };
}
