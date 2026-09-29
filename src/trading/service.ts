import { parseUnits, SwapSdkError } from "@rhea-finance/cross-chain-aggregation-dex";
import { RheaClient } from "../rhea/client.js";
import { RheaTradingEngine } from "./rhea-engine.js";
import { NearAccountSigner } from "../wallet/near-account-signer.js";
import { WalletService } from "../wallet/service.js";
import { getFtBalance, getNearBalance } from "../near/account.js";
import { assertSlippageAllowed, assertTradeShareAllowed, getSpendableBalance } from "../security/risk.js";
import type { TradeQuote, TradeRequest } from "../domain/trading.js";
import { NoopTradeRepository, PostgresTradeRepository, type TradeRepository } from "./repository.js";
import { config } from "../config.js";

const WRAPPED_NEAR = "wrap.near";
const DEFAULT_SLIPPAGE_BPS = 100;
const PENDING_TTL_MS = 2 * 60 * 1000;

type PendingTrade = {
  userId: number;
  request: TradeRequest;
  quote: TradeQuote;
  expiresAt: number;
};

const pending = new Map<string, PendingTrade>();

type NearToken = Awaited<ReturnType<RheaClient["getNearTokens"]>>[number];

function findNearNative(tokens: readonly NearToken[]): NearToken {
  const token = tokens.find((item) => item.address.toLowerCase() === WRAPPED_NEAR);
  if (!token) throw new Error("RHEA did not return wrap.near in the NEAR token list");
  return token;
}

function cleanupPending(): void {
  const now = Date.now();
  for (const [id, trade] of pending) {
    if (trade.expiresAt <= now) pending.delete(id);
  }
}

function isExecutionUncertain(error: unknown): boolean {
  if (!(error instanceof SwapSdkError)) return false;

  return ["broadcast", "submit", "status", "report"].includes(error.stage);
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

    const wallet = await this.walletService.getWallet(userId);
    if (!wallet) throw new Error("Create a Neyro wallet first with /wallet");

    const amountText = humanAmount.trim();
    if (!/^\d+(\.\d+)?$/.test(amountText) || /^0+(?:\.0*)?$/.test(amountText)) {
      throw new Error("Amount must be a positive decimal number");
    }

    const token = await this.rhea.resolveNearToken(tokenQuery);
    const tokens = await this.rhea.getNearTokens();
    const near = findNearNative(tokens);

    const tokenIn = side === "buy" ? near : token;
    const tokenOut = side === "buy" ? token : near;
    const amountIn = parseUnits(amountText, tokenIn.decimals);

    const slippageBps = DEFAULT_SLIPPAGE_BPS;
    assertSlippageAllowed(slippageBps);

    const nearBalance = BigInt(await getNearBalance(wallet.accountId));
    const reserve = BigInt(config.NEAR_SPENDABLE_RESERVE_YOCTO);
    getSpendableBalance(nearBalance, reserve);

    if (side === "buy") {
      const spendableBalance = getSpendableBalance(nearBalance, reserve);
      const amount = BigInt(amountIn);

      if (amount > spendableBalance) {
        throw new Error("Insufficient NEAR balance after the safety reserve");
      }

      const shareBps = Number((amount * 10000n) / spendableBalance);
      assertTradeShareAllowed(shareBps);
    } else {
      const tokenBalance = await getFtBalance(wallet.accountId, token.address);
      const amount = BigInt(amountIn);

      if (amount > tokenBalance) {
        throw new Error("Insufficient token balance");
      }

      const shareBps = Number(
        (amount * 10000n) / (tokenBalance === 0n ? 1n : tokenBalance)
      );
      assertTradeShareAllowed(shareBps);
    }

    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);

    const request: TradeRequest = {
      accountId: wallet.accountId,
      side,
      tokenIn,
      tokenOut,
      amountIn,
      slippageBps,
      idempotencyKey: id
    };

    const engine = new RheaTradingEngine();
    const quote = await engine.quote(request);
    const expiresAt = Date.now() + PENDING_TTL_MS;

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

    return { id, request, quote, expiresAt };
  }

  async execute(userId: number, id: string) {
    cleanupPending();

    const trade = pending.get(id);
    if (!trade || trade.userId !== userId) {
      throw new Error("Trade confirmation expired or is invalid");
    }

    pending.delete(id);
    await this.repository.updateStatus(userId, id, "executing");

    try {
      const account = await this.walletService.getSigningAccount(userId);
      const engine = new RheaTradingEngine(
        new NearAccountSigner(account, [
          trade.request.tokenIn.address,
          trade.request.tokenOut.address
        ])
      );
      const result = await engine.execute(trade.request, trade.quote);

      await this.repository.updateStatus(
        userId,
        id,
        "submitted",
        result.transactionHash
      );

      return result;
    } catch (error) {
      if (isExecutionUncertain(error)) {
        await this.repository.updateStatus(
          userId,
          id,
          "executing",
          undefined,
          `execution_uncertain:${error.stage}`
        );

        throw new Error(
          "Trade execution status is uncertain. Do not retry with a new trade until the transaction status is reconciled."
        );
      }

      await this.repository.updateStatus(
        userId,
        id,
        "failed",
        undefined,
        error instanceof Error ? error.message.slice(0, 200) : "execution_failed"
      );
      throw error;
    }
  }

  cancel(userId: number, id: string): void {
    const trade = pending.get(id);
    if (trade?.userId === userId) {
      pending.delete(id);
      void this.repository.updateStatus(userId, id, "cancelled");
    }
  }
}
