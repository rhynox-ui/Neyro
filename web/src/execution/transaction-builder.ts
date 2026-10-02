import type { TransferBatch } from "../airdrop/batch-builder";
import type { SignAndSendRequest, WalletTransactionAction } from "../wallet/connector";

export function buildAirdropTransaction(
  senderId: string,
  tokenContract: string,
  batch: TransferBatch
): SignAndSendRequest {
  if (!senderId) throw new Error("senderId is required");
  if (!tokenContract) throw new Error("tokenContract is required");
  if (batch.senderId !== senderId) {
    throw new Error("batch sender does not match signer");
  }
  if (batch.actions.length === 0) {
    throw new Error("batch must contain at least one action");
  }

  const actions: WalletTransactionAction[] = batch.actions.map((action) => ({
    type: "FunctionCall",
    receiverId: tokenContract,
    methodName: action.methodName,
    args: action.args,
    gas: action.gas,
    deposit: action.deposit
  }));

  return {
    signerId: senderId,
    receiverId: tokenContract,
    actions
  };
}

export function buildNativeFeeTransfer(
  signerId: string,
  treasuryAccount: string,
  amountYoctoNear: bigint
): SignAndSendRequest {
  if (!signerId) throw new Error("signerId is required");
  if (!treasuryAccount) throw new Error("treasuryAccount is required");
  if (amountYoctoNear <= 0n) {
    throw new Error("fee amount must be greater than zero");
  }

  return {
    signerId,
    receiverId: treasuryAccount,
    actions: [{
      type: "Transfer",
      receiverId: treasuryAccount,
      deposit: amountYoctoNear
    }]
  };
}
