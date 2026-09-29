import type { WalletAction } from "../near/actions.js";
import type { PlannedTransaction } from "../wallet/near-account-signer.js";
import { UserFacingError } from "../errors.js";

/**
 * Contracts a RHEA same-chain swap may send tokens into (ft_transfer_call
 * receivers) or call directly. Extend with RHEA_EXTRA_CONTRACTS if RHEA's
 * builder routes through another contract; unknown receivers are blocked.
 */
export const DEFAULT_DEX_CONTRACTS = ["v2.ref-finance.near", "dclv2.ref-labs.near", "aggregatedex.near"];

const WRAPPED_NEAR = "wrap.near";
/** Storage registrations (NEP-145) cost ~0.00125 NEAR each; allow a few. */
const MAX_STORAGE_DEPOSIT = 10n ** 23n; // 0.1 NEAR per call
const MAX_TOTAL_STORAGE = 25n * 10n ** 22n; // 0.25 NEAR per batch

export type SwapIntent = {
  side: "buy" | "sell";
  accountId: string;
  /** Contract of the token being spent (wrap.near for NEAR on buys). */
  tokenIn: string;
  tokenOut: string;
  /** Base units the user agreed to swap (after the protocol fee). */
  amountIn: bigint;
  dexContracts: readonly string[];
};

export class TradePolicyError extends UserFacingError {}

function block(reason: string): never {
  throw new TradePolicyError(`Trade blocked by a safety check: ${reason}`);
}

function amountArg(action: Extract<WalletAction, { type: "FunctionCall" }>, key: string): bigint {
  const value = action.params.args[key];
  if (typeof value !== "string" || !/^\d+$/.test(value)) block(`${action.params.methodName} has no valid ${key}`);
  return BigInt(value);
}

/**
 * Independently checks RHEA's built transactions against the confirmed
 * trade before anything is signed, so a wrong or compromised API response
 * can't move funds elsewhere:
 * - only the trade's tokens, wrap.near and allowlisted DEX contracts are called
 * - tokens only go to allowlisted DEX contracts, never more than the agreed amount
 * - no plain NEAR transfers, and attached NEAR is bounded by the trade plus
 *   a small storage allowance
 * - storage registrations are only for the user's own account or a DEX contract
 */
export function assertSwapMatchesIntent(transactions: readonly PlannedTransaction[], intent: SwapIntent): void {
  const dexes = new Set(intent.dexContracts);
  const tokenContracts = new Set([intent.tokenIn, intent.tokenOut, WRAPPED_NEAR]);
  let spent = 0n;
  let wrapped = 0n;
  let storage = 0n;

  for (const tx of transactions) {
    const receiver = tx.receiverId;
    if (!tokenContracts.has(receiver) && !dexes.has(receiver)) block(`unexpected contract ${receiver}`);

    for (const action of tx.actions) {
      if (action.type === "Transfer") block(`plain NEAR transfer to ${receiver}`);
      const { methodName, args, deposit } = action.params;
      const attached = BigInt(deposit);

      switch (methodName) {
        case "storage_deposit": {
          const account = args.account_id;
          if (account !== undefined && account !== intent.accountId && !dexes.has(String(account))) {
            block(`storage registration for another account (${String(account)})`);
          }
          if (attached > MAX_STORAGE_DEPOSIT) block("storage deposit is too large");
          storage += attached;
          break;
        }
        case "near_deposit": {
          if (receiver !== WRAPPED_NEAR || intent.side !== "buy") block("unexpected NEAR wrap");
          wrapped += attached;
          break;
        }
        case "near_withdraw": {
          if (receiver !== WRAPPED_NEAR) block("unexpected unwrap");
          if (attached > 1n) block("unwrap carries a deposit");
          break;
        }
        case "ft_transfer_call": {
          if (receiver !== intent.tokenIn) block(`sends ${receiver}, not the token being sold`);
          if (!dexes.has(String(args.receiver_id))) block(`sends tokens to ${String(args.receiver_id)}`);
          if (attached > 1n) block("token transfer carries a deposit");
          spent += amountArg(action, "amount");
          break;
        }
        default: {
          // The swap path only needs the explicit actions handled above.
          // Never sign an arbitrary method supplied by the remote route builder,
          // even on an allowlisted DEX.
          block(`unexpected call ${methodName} on ${receiver}`);
        }
      }
    }
  }

  if (spent > intent.amountIn) block("spends more than the confirmed amount");
  if (intent.side === "buy" && wrapped > intent.amountIn) block("wraps more NEAR than the confirmed amount");
  if (storage > MAX_TOTAL_STORAGE) block("storage deposits are too large");
}
