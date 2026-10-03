import type { CampaignBatch } from "../campaign/model";
import type { NearRpcClient, TxStatusResult } from "../near/rpc";

/**
 * Chain state captured immediately before a batch is handed to the browser
 * wallet. It is the only evidence that can later prove a hashless batch was
 * never executed: every included transaction increments the nonce of the
 * access key that signed it, and no transaction signed after this snapshot can
 * be included once the network's transaction validity window has passed.
 */
export type SigningEvidence = {
  capturedAtBlockHeight: number;
  accessKeyNonces: Record<string, string>;
};

export type NonExecutionCheck =
  | { proven: true; checkedAtBlockHeight: number }
  | { proven: false; reason: string };

// Extra blocks beyond the protocol validity window before non-execution is
// accepted, so block-height reads from different RPC nodes cannot race it.
export const VALIDITY_SAFETY_MARGIN_BLOCKS = 1_000;

function nonceString(value: number | string): string {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error("NEAR RPC returned an invalid access-key nonce");
  return text;
}

export async function captureSigningEvidence(
  rpc: NearRpcClient,
  accountId: string
): Promise<SigningEvidence> {
  const list = await rpc.viewAccessKeyList(accountId);
  if (!Number.isSafeInteger(list.block_height) || list.block_height <= 0) {
    throw new Error("NEAR RPC returned an invalid block height for access keys");
  }
  const accessKeyNonces: Record<string, string> = {};
  for (const key of list.keys) {
    accessKeyNonces[key.public_key] = nonceString(key.access_key.nonce);
  }
  if (Object.keys(accessKeyNonces).length === 0) {
    throw new Error(`Sender ${accountId} has no access keys`);
  }
  return { capturedAtBlockHeight: list.block_height, accessKeyNonces };
}

/**
 * Proves a hashless batch was never executed, or explains why that cannot be
 * proven yet. Proof requires both:
 * - the validity window for any transaction signed after the snapshot has
 *   closed, so nothing signed then can still be included; and
 * - the sender's access-key set is unchanged and no nonce advanced, so nothing
 *   signed by the sender was included in the meantime.
 *
 * Any other sender activity makes the result ambiguous; the user must then
 * supply the transaction hash (or confirm none exists elsewhere) instead.
 */
export async function checkNotExecuted(
  rpc: NearRpcClient,
  accountId: string,
  evidence: SigningEvidence
): Promise<NonExecutionCheck> {
  const [list, validityPeriod] = await Promise.all([
    rpc.viewAccessKeyList(accountId),
    rpc.transactionValidityPeriod()
  ]);

  const current = new Map(
    list.keys.map((key) => [key.public_key, nonceString(key.access_key.nonce)])
  );
  const before = Object.entries(evidence.accessKeyNonces);

  if (current.size !== before.length || before.some(([key]) => !current.has(key))) {
    return {
      proven: false,
      reason: `Access keys of ${accountId} changed since signing began; supply the transaction hash if one exists.`
    };
  }

  const advanced = before.filter(([key, nonce]) => BigInt(current.get(key)!) !== BigInt(nonce));
  if (advanced.length > 0) {
    return {
      proven: false,
      reason: `${accountId} has sent transactions since signing began; supply this batch's transaction hash to reconcile it.`
    };
  }

  const safeAfter =
    evidence.capturedAtBlockHeight + validityPeriod + VALIDITY_SAFETY_MARGIN_BLOCKS;
  if (list.block_height <= safeAfter) {
    return {
      proven: false,
      reason: `No transaction from ${accountId} has been included yet, but one signed during this attempt could still be accepted until block ${safeAfter.toLocaleString()} (current ${list.block_height.toLocaleString()}). Close any open wallet windows and check again later, or supply the hash.`
    };
  }

  return { proven: true, checkedAtBlockHeight: list.block_height };
}

type RpcTransaction = {
  signer_id?: unknown;
  receiver_id?: unknown;
  actions?: unknown;
};

function decodeArgs(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Checks that an on-chain transaction is exactly this batch: same signer,
 * token contract, and ordered ft_transfer recipients/amounts with the 1 yocto
 * deposit. Used before trusting a user-supplied hash for a hashless batch.
 */
export function transactionMatchesBatch(
  result: TxStatusResult,
  batch: CampaignBatch,
  tokenContract: string
): { matches: true } | { matches: false; reason: string } {
  const transaction = result.transaction as RpcTransaction | undefined;
  if (!transaction || typeof transaction !== "object") {
    return { matches: false, reason: "RPC response did not include the transaction body" };
  }
  if (transaction.signer_id !== batch.senderId) {
    return { matches: false, reason: `Transaction signer is not ${batch.senderId}` };
  }
  if (transaction.receiver_id !== tokenContract) {
    return { matches: false, reason: `Transaction receiver is not ${tokenContract}` };
  }
  const actions = Array.isArray(transaction.actions) ? transaction.actions : [];
  if (actions.length !== batch.recipients.length) {
    return {
      matches: false,
      reason: `Transaction has ${actions.length} actions; batch has ${batch.recipients.length}`
    };
  }

  for (let index = 0; index < actions.length; index += 1) {
    const call = (actions[index] as { FunctionCall?: Record<string, unknown> } | null)?.FunctionCall;
    const expected = batch.recipients[index];
    if (!call || call.method_name !== "ft_transfer") {
      return { matches: false, reason: `Action ${index + 1} is not ft_transfer` };
    }
    if (String(call.deposit) !== "1") {
      return { matches: false, reason: `Action ${index + 1} does not attach 1 yoctoNEAR` };
    }
    const args = decodeArgs(call.args);
    if (!args || args.receiver_id !== expected.wallet || args.amount !== expected.amountBase) {
      return {
        matches: false,
        reason: `Action ${index + 1} does not transfer ${expected.amountBase} to ${expected.wallet}`
      };
    }
  }

  return { matches: true };
}
