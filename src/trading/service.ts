import { parseUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import type { AssetRef } from "@rhea-finance/cross-chain-aggregation-dex";
import { RheaClient } from "../rhea/client.js";
import { RheaTradingEngine } from "./rhea-engine.js";
import { NearAccountSigner } from "../wallet/near-account-signer.js";
import { WalletService } from "../wallet/service.js";
import { getNearBalance } from "../near/account.js";
import { assertSlippageAllowed, assertTradeShareAllowed } from "../security/risk.js";
import type { TradeQuote, TradeRequest } from "../domain/trading.js";

const WRAPPED_NEAR = "wrap.near";
const DEFAULT_SLIPPAGE_BPS = 100;
const PENDING_TTL_MS = 2 * 60 * 1000;

type PendingTrade = { userId: number; request: TradeRequest; quote: TradeQuote; expiresAt: number };

const pending = new Map<string, PendingTrade>();

function findNearNative(tokens: readonly AssetRef[]) {
  const token = tokens.find((item) => item.address.toLowerCase() === WRAPPED_NEAR);
  if (!token) throw new Error("RHEA did not return wrap.near in the NEAR token list");
  return token;
}

function cleanupPending() {
  const now = Date.now();
  for (const [id, trade] of pending) if (trade.expiresAt <= now) pending.delete(id);
}

export class TradingService {
  private readonly walletService: WalletService;
  private readonly rhea: RheaClient;

  constructor(walletService = new WalletService(), rhea = new RheaClient()) {
    this.walletService = walletService;
    this.rhea = rhea;
  }

  async prepare(userId: number, side: "buy" | "sell", tokenQuery: string, humanAmount: string) {
    cleanupPending();
    const wallet = await this.walletService.getWallet(userId);
    if (!wallet) throw new Error("Create a Neyro wallet first with /wallet");

    const amountText = humanAmount.trim();
    if (!/^\d+(\.\d+)?$/.test(amountText) || Number(amountText) <= 0) {
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

    if (side === "buy") {
      const balance = BigInt(await getNearBalance(wallet.accountId));
      const amount = BigInt(amountIn);
      if (amount > balance) throw new Error("Insufficient NEAR balance");
      assertTradeShareAllowed(Number((amount * 10000n) / (balance === 0n ? 1n : balance)));
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

    pending.set(id, { userId, request, quote, expiresAt: Date.now() + PENDING_TTL_MS });

    return { id, request, quote, expiresAt: Date.now() + PENDING_TTL_MS };
  }

  async execute(userId: number, id: string) {
    cleanupPending();
    const trade = pending.get(id);
    if (!trade || trade.userId !== userId) throw new Error("Trade confirmation expired or is invalid");

    pending.delete(id);
    const account = await this.walletService.getSigningAccount(userId);
    const engine = new RheaTradingEngine(new NearAccountSigner(account));
    return engine.execute(trade.request, trade.quote);
  }

  cancel(userId: number, id: string) {
    const trade = pending.get(id);
    if (trade?.userId === userId) pending.delete(id);
  }
}