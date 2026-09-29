import { formatUnits, parseUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { functionCall, type WalletAction } from "../near/actions.js";
import { getNearBalance } from "../near/account.js";
import { ftBalanceOf, ftMetadata, storageRegistrationCost } from "../near/ft.js";
import { isValidAccountId, looksLikeContractId } from "../near/tokens.js";
import { UserFacingError } from "../errors.js";
import { NearAccountSigner, type PlannedTransaction } from "./near-account-signer.js";
import type { WalletService } from "./service.js";
import { classifyBatch, type BatchOutcome } from "../trading/outcome.js";
import { defaultStateStore, type StateStore } from "../state/store.js";

/** Left behind on a NEAR withdrawal to pay for its own gas. */
export const WITHDRAW_GAS_RESERVE = 10n ** 22n; // 0.01 NEAR
const FT_TRANSFER_GAS = 30_000_000_000_000n;
const STORAGE_DEPOSIT_GAS = 10_000_000_000_000n;
const PENDING_TTL_MS = 2 * 60 * 1000;

export type WithdrawAsset =
  | { kind: "near"; symbol: "NEAR"; decimals: 24 }
  | { kind: "ft"; contractId: string; symbol: string; decimals: number };

export type WithdrawPlan = {
  id: string;
  userId: number;
  from: string;
  to: string;
  asset: WithdrawAsset;
  amount: bigint;
  /** yoctoNEAR to register the receiver on the token contract, if needed. */
  registration: bigint;
  expiresAt: number;
};

export type WithdrawResult = {
  status: BatchOutcome;
  txHashes: string[];
  reason?: string;
};

/** Accounts that exist without being created: implicit (64 hex) and ETH-implicit (0x + 40 hex). */
export function isImplicitAccount(accountId: string): boolean {
  return /^[0-9a-f]{64}$/.test(accountId) || /^0x[0-9a-f]{40}$/.test(accountId);
}

export function buildWithdrawTransactions(plan: Pick<WithdrawPlan, "to" | "asset" | "amount" | "registration">): PlannedTransaction[] {
  if (plan.asset.kind === "near") {
    const transfer: WalletAction = { type: "Transfer", params: { deposit: plan.amount.toString() } };
    return [{ receiverId: plan.to, actions: [transfer] }];
  }
  // One transaction on the token contract: register the receiver if needed,
  // then transfer.
  return [{
    receiverId: plan.asset.contractId,
    actions: [
      ...(plan.registration > 0n
        ? [functionCall("storage_deposit", { account_id: plan.to, registration_only: true }, STORAGE_DEPOSIT_GAS, plan.registration)]
        : []),
      functionCall("ft_transfer", { receiver_id: plan.to, amount: plan.amount.toString() }, FT_TRANSFER_GAS, 1n)
    ]
  }];
}

export function formatWithdrawAmount(plan: Pick<WithdrawPlan, "asset" | "amount">): string {
  return `${formatUnits(plan.amount.toString(), plan.asset.decimals)} ${plan.asset.symbol}`;
}

type StoredPlan = Omit<WithdrawPlan, "amount" | "registration"> & { amount: string; registration: string };

const toStored = (plan: WithdrawPlan): StoredPlan =>
  ({ ...plan, amount: plan.amount.toString(), registration: plan.registration.toString() });
const fromStored = (plan: StoredPlan): WithdrawPlan =>
  ({ ...plan, amount: BigInt(plan.amount), registration: BigInt(plan.registration) });
const planKey = (id: string) => `withdraw:${id}`;

export class WithdrawService {
  constructor(
    private readonly walletService: WalletService,
    private readonly resolveSymbol: (query: string) => Promise<{ address: string; symbol: string; decimals: number; contractAddress?: string | null }>,
    private readonly store: StateStore = defaultStateStore()
  ) {}

  private async resolveAsset(query: string): Promise<WithdrawAsset> {
    const needle = query.trim().toLowerCase();
    if (needle === "near") return { kind: "near", symbol: "NEAR", decimals: 24 };
    if (looksLikeContractId(needle)) {
      const metadata = await ftMetadata(needle).catch(() => {
        throw new UserFacingError("That contract is not a NEP-141 token on NEAR");
      });
      return { kind: "ft", contractId: needle, symbol: metadata.symbol, decimals: metadata.decimals };
    }
    const token = await this.resolveSymbol(needle);
    return { kind: "ft", contractId: token.contractAddress ?? token.address, symbol: token.symbol, decimals: token.decimals };
  }

  async prepare(userId: number, amountText: string, assetQuery: string, toText: string): Promise<WithdrawPlan> {
    const wallet = await this.walletService.getWallet(userId);
    if (!wallet) throw new UserFacingError("Create a Neyro wallet first with /wallet");

    const to = toText.trim().toLowerCase();
    if (!isValidAccountId(to)) throw new UserFacingError("That is not a valid NEAR account id");
    if (to === wallet.accountId) throw new UserFacingError("That is your own Neyro wallet");
    if (!isImplicitAccount(to) && !(await getNearBalance(to)).exists) {
      throw new UserFacingError(`${to} does not exist on NEAR. Check the address; transfers can't be reversed.`);
    }

    const asset = await this.resolveAsset(assetQuery);
    const all = amountText.trim().toLowerCase() === "all";
    if (!all && (!/^\d+(\.\d+)?$/.test(amountText.trim()) || !(Number(amountText) > 0))) {
      throw new UserFacingError("Amount must be a positive number or \"all\"");
    }

    let amount: bigint;
    let registration = 0n;
    if (asset.kind === "near") {
      const balance = await getNearBalance(wallet.accountId);
      const max = balance.available > WITHDRAW_GAS_RESERVE ? balance.available - WITHDRAW_GAS_RESERVE : 0n;
      amount = all ? max : BigInt(parseUnits(amountText.trim(), 24));
      if (amount <= 0n) throw new UserFacingError("No NEAR available to withdraw");
      if (amount > max) {
        throw new UserFacingError(`You can withdraw at most ${formatUnits(max.toString(), 24)} NEAR (0.01 NEAR stays for gas)`);
      }
    } else {
      const balance = await ftBalanceOf(asset.contractId, wallet.accountId);
      amount = all ? balance : BigInt(parseUnits(amountText.trim(), asset.decimals));
      if (amount <= 0n) throw new UserFacingError(`No ${asset.symbol} to withdraw`);
      if (amount > balance) {
        throw new UserFacingError(`You only have ${formatUnits(balance.toString(), asset.decimals)} ${asset.symbol}`);
      }
      registration = await storageRegistrationCost(asset.contractId, to);
    }

    const plan: WithdrawPlan = {
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
      userId,
      from: wallet.accountId,
      to,
      asset,
      amount,
      registration,
      expiresAt: Date.now() + PENDING_TTL_MS
    };
    await this.store.set(userId, planKey(plan.id), toStored(plan), PENDING_TTL_MS);
    return plan;
  }

  /** The pending plan, for rendering; throws if it is not this user's or has expired. */
  async peek(userId: number, id: string): Promise<WithdrawPlan> {
    const stored = await this.store.get<StoredPlan>(userId, planKey(id));
    if (!stored || stored.expiresAt <= Date.now()) {
      throw new UserFacingError("Withdrawal confirmation expired or is invalid");
    }
    return fromStored(stored);
  }

  async cancel(userId: number, id: string): Promise<void> {
    await this.store.delete(userId, planKey(id));
  }

  async execute(userId: number, id: string): Promise<WithdrawResult> {
    // take() consumes the plan atomically: a second tap, even on another
    // instance, finds nothing and can't send twice.
    const stored = await this.store.take<StoredPlan>(userId, planKey(id));
    if (!stored || stored.userId !== userId || stored.expiresAt <= Date.now()) {
      throw new UserFacingError("Withdrawal confirmation expired or is invalid");
    }
    const plan = fromStored(stored);

    const account = await this.walletService.getSigningAccount(userId, plan.from);
    const signer = new NearAccountSigner(account);
    let error: unknown;
    try {
      await signer.signAndSendTransactions(buildWithdrawTransactions(plan), {});
    } catch (caught) {
      error = caught;
      if (signer.sent.some((item) => item.result === "unknown")) await signer.reconcile();
    }
    const status = classifyBatch(signer.sent);
    if (status !== "executed") console.error("Withdrawal did not complete", { id, status, error });
    return {
      status,
      txHashes: signer.sent.map((item) => item.txHash),
      reason: signer.sent.find((item) => item.failure)?.failure
    };
  }
}
