export const YOCTONEAR = 1n;
export const DEFAULT_PREPAID_GAS = 30_000_000_000_000n; // 30 Tgas

export type FtTransferCall = {
  receiverId: string;
  amount: string;
  memo?: string;
};

export type FunctionCallAction = {
  methodName: "ft_transfer";
  args: FtTransferCall;
  gas: bigint;
  deposit: bigint;
};

export type TransferBatch = {
  batchId: string;
  senderId: string;
  actions: FunctionCallAction[];
  totalAmount: bigint;
};

export function buildFtTransferAction(
  receiverId: string,
  amountBase: bigint,
  gas = DEFAULT_PREPAID_GAS,
  memo?: string
): FunctionCallAction {
  if (!receiverId) throw new Error("receiverId is required");
  if (amountBase <= 0n) throw new Error("transfer amount must be greater than zero");
  if (gas <= 0n) throw new Error("gas must be greater than zero");

  return {
    methodName: "ft_transfer",
    args: {
      receiverId,
      amount: amountBase.toString(),
      ...(memo ? { memo } : {})
    },
    gas,
    deposit: YOCTONEAR
  };
}

export function buildTransferBatches(
  senderId: string,
  recipients: Array<{ wallet: string; amountBase: bigint }>,
  maxActions = 50,
  gasPerAction = DEFAULT_PREPAID_GAS
): TransferBatch[] {
  if (!senderId) throw new Error("senderId is required");
  if (!Number.isInteger(maxActions) || maxActions <= 0) {
    throw new Error("maxActions must be a positive integer");
  }

  const batches: TransferBatch[] = [];

  for (let offset = 0; offset < recipients.length; offset += maxActions) {
    const slice = recipients.slice(offset, offset + maxActions);
    const actions = slice.map((recipient) =>
      buildFtTransferAction(recipient.wallet, recipient.amountBase, gasPerAction)
    );

    batches.push({
      batchId: `${senderId}:${batches.length}`,
      senderId,
      actions,
      totalAmount: actions.reduce(
        (total, action) => total + BigInt(action.args.amount),
        0n
      )
    });
  }

  return batches;
}
