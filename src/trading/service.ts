import { parseUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { RheaClient } from "../rhea/client.js";
import { RheaTradingEngine } from "./rhea-engine.js";
import { NearAccountSigner } from "../wallet/near-account-signer.js";
import { WalletService } from "../wallet/service.js";
import { getNearBalance, tradableNear } from "../near/account.js";
import { ftBalanceOf } from "../near/ft.js";
import { assertSlippageAllowed, assertTradeShareAllowed } from "../security/risk.js";
import type { TradeQuote, TradeRequest } from "../domain/trading.js";
import {
  NoopTradeRepository,
  PostgresTradeRepository,
  type TradeRepository,
  type TradeStatus
} from "./repository.js";
import { assessFill, classifyBatch, quoteDeadline } from "./outcome.js";
import { config, TRADING_ENABLED } from "../config.js";
import { UserFacingError, userMessage } from "../errors.js";

const WRAPPED_NEAR = "wrap.near";
const DEFAULT_SLIPPAGE_BPS = 100;
const PENDING_TTL_MS = 2 * 60 * 1000;

type PendingTrade = {
  userId: number;
  request: TradeRequest;
  quote: TradeQuote;
  expiresAt: number;
};

export type ExecutionResult = {
  status: Extract<TradeStatus, "filled" | "submitted" | "reverted" | "partial" | "unknown" | "failed">;
  txHashes: string[];
  /** Base units of the FT side that moved, when the fill was verified. */
  filledAmount?: string;
  reason?: string;
};

const pending = new Map<string, PendingTrade>();
const executing = new Set<number>();

type NearToken = Awaited<ReturnType<RheaClient["getNearTokens"]>>[number];

function findNearNative(tokens: readonly NearToken[]): NearToken {
  const token = tokens.find((item) => item.address.toLowerCase() === WRAPPED_NEAR);
  if (!token) throw new Error("RHEA did not return wrap.near in the NEAR token list");
  return token;
}

function contractOf(token: TradeRequest["tokenIn"]): string {
  const contractAddress = (token as { contractAddress?: string | null }).contractAddress;
  return contractAddress ?? token.address;
}

function cleanupPending(): void {
  const now = Date.now();
  for (const [id, trade] of pending) {
    if (trade.expiresAt <= now) pending.delete(id);
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "execution_failed";
}

export class TradingService {
  private readonly walletService: WalletService;
  private readonly rhea: RheaClient;
  private readonly repository: TradeRepository;

  constructor(
    walletService = new WalletService(),
    rhea = new RheaClient(),
    repository?: TradeRepository
  ) {
    this.walletService = walletService;
    this.rhea = rhea;
    this.repository = repository ?? (config.DATABASE_URL
      ? new PostgresTradeRepository(config.DATABASE_URL)
      : new NoopTradeRepository());
  }

  async prepare(
    userId: number,
    side: "buy" | "sell",
    tokenQuery: string,
    humanAmount: string
  ) {
    cleanupPending();

    if (!TRADING_ENABLED) {
      throw new UserFacingError("Trading uses RHEA liquidity on NEAR mainnet only; this bot is running on testnet");
    }

    const wallet = await this.walletService.getWallet(userId);
    if (!wallet) throw new UserFacingError("Create a Neyro wallet first with /wallet");

    const amountText = humanAmount.trim();
    if (!/^\d+(\.\d+)?$/.test(amountText) || /^0+(?:\.0*)?$/.test(amountText)) {
      throw new UserFacingError("Amount must be a positive decimal number");
    }

    const token = await this.rhea.resolveNearToken(tokenQuery);
    const tokens = await this.rhea.getNearTokens();
    const near = findNearNative(tokens);
    if (token.address.toLowerCase() === near.address.toLowerCase()) {
      throw new UserFacingError("Choose a token other than NEAR");
    }

    const tokenIn = side === "buy" ? near : token;
    const tokenOut = side === "buy" ? token : near;
    const amountIn = parseUnits(amountText, tokenIn.decimals);

    const slippageBps = DEFAULT_SLIPPAGE_BPS;
    assertSlippageAllowed(slippageBps);

    if (side === "buy") {
      const balance = tradableNear(await getNearBalance(wallet.accountId));
      const amount = BigInt(amountIn);
      if (amount > balance) {
        throw new UserFacingError("Insufficient NEAR balance (0.05 NEAR is kept for gas and storage)");
      }

      const shareBps = Number(
        (amount * 10000n) / (balance === 0n ? 1n : balance)
      );
      assertTradeShareAllowed(shareBps);
    } else {
      const balance = await ftBalanceOf(contractOf(tokenIn), wallet.accountId);
      if (BigInt(amountIn) > balance) throw new UserFacingError(`Insufficient ${tokenIn.symbol} balance`);
    }

    const request: TradeRequest = {
      accountId: wallet.accountId,
      side,
      tokenIn,
      tokenOut,
      amountIn,
      slippageBps
    };

    const engine = new RheaTradingEngine();
    const quote = await engine.quote(request);
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const expiresAt = quoteDeadline(Date.now(), PENDING_TTL_MS, quote.raw.expiresAt);

    pending.set(id, { userId, request, quote, expiresAt });

    await this.repository.create({
      userId,
      accountId: wallet.accountId,
      side,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn,
      expectedOut: quote.expectedOut,
      slippageBps,
      router: quote.router,
      idempotencyKey: id,
      status: "quoted"
    });

    return { id, request, quote, expiresAt, unlisted: !token.listed };
  }

  async execute(userId: number, id: string): Promise<ExecutionResult> {
    cleanupPending();

    const trade = pending.get(id);
    if (!trade || trade.userId !== userId) {
      throw new UserFacingError("Trade confirmation expired or is invalid");
    }
    if (executing.has(userId)) {
      throw new UserFacingError("Another trade is still executing; wait for it to finish");
    }

    pending.delete(id);
    executing.add(userId);
    try {
      return await this.executeTrade(userId, id, trade);
    } finally {
      executing.delete(userId);
    }
  }

  private async executeTrade(userId: number, id: string, trade: PendingTrade): Promise<ExecutionResult> {
    await this.repository.updateStatus(userId, id, { status: "executing" });

    const { request } = trade;
    const ftContract = contractOf(request.side === "buy" ? request.tokenOut : request.tokenIn);
    const before = await ftBalanceOf(ftContract, request.accountId).catch(() => undefined);

    let signer: NearAccountSigner | undefined;
    let sdkError: unknown;
    try {
      const account = await this.walletService.getSigningAccount(userId);
      signer = new NearAccountSigner(account, {
        beforeBroadcast: (txHash, receiverId) =>
          this.repository.recordEvent(userId, id, { type: "tx_signed", txHash, details: { receiverId } })
      });
      await new RheaTradingEngine(signer).execute(request, trade.quote);
    } catch (error) {
      sdkError = error;
    }

    const sent = signer?.sent ?? [];
    if (sdkError !== undefined && sent.some((item) => item.result === "unknown")) {
      await signer?.reconcile();
    }

    const txHashes = sent.map((item) => item.txHash);
    const lastHash = txHashes[txHashes.length - 1];
    const batch = classifyBatch(sent);

    if (batch !== "executed") {
      const chainFailure = sent.find((item) => item.failure)?.failure;
      await this.repository.updateStatus(userId, id, {
        status: batch,
        txHash: lastHash,
        errorCode: chainFailure ?? errorCode(sdkError)
      });
      console.error("Trade did not complete", { id, status: batch, txHashes, error: sdkError });
      // On-chain failure text is public; SDK/RPC error text is not shown to users.
      return {
        status: batch,
        txHashes,
        reason: chainFailure ?? userMessage(sdkError, "Execution error")
      };
    }

    // Every transaction executed. Verify the swap actually filled rather
    // than being refunded inside ft_transfer_call.
    const after = before === undefined
      ? undefined
      : await ftBalanceOf(ftContract, request.accountId).catch(() => undefined);

    if (before === undefined || after === undefined) {
      await this.repository.updateStatus(userId, id, { status: "submitted", txHash: lastHash });
      return { status: "submitted", txHashes };
    }

    const fill = assessFill(request.side, before, after);
    const status = fill.filled ? "filled" : "reverted";
    const reason = fill.filled ? undefined : "Swap was refunded; no tokens were exchanged";
    await this.repository.updateStatus(userId, id, {
      status,
      txHash: lastHash,
      actualOut: request.side === "buy" && fill.filled ? fill.amount.toString() : undefined,
      errorCode: reason
    });
    return { status, txHashes, filledAmount: fill.amount.toString(), reason };
  }

  cancel(userId: number, id: string): void {
    const trade = pending.get(id);
    if (trade?.userId === userId) {
      pending.delete(id);
      void this.repository.updateStatus(userId, id, { status: "cancelled" });
    }
  }
}
