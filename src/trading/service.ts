import { buildQuotePricer, onchainMarket, type QuotePricer } from "../market/onchain.js";
import { formatUnits, parseUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { RheaClient, isNearNative, stripAssetPrefix } from "../rhea/client.js";
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
  type PendingPayload,
  type TradeRepository,
  type TradeStatus
} from "./repository.js";
import { assessFill, classifyBatch, estimateValueLoss, quoteDeadline } from "./outcome.js";
import { config, FEE_BPS, TRADING_ENABLED } from "../config.js";
import { computeFee, feeActions, type FeePlan } from "./fee.js";
import { assertSwapMatchesIntent, DEFAULT_DEX_CONTRACTS } from "./policy.js";
import { storageRegistrationCost } from "../near/ft.js";
import { fetchNearMarket } from "../market/dexscreener.js";
import { nearUsdFromDcl } from "../market/dcl.js";
import { fetchLaunchByToken, isNearlyToken, nearlyPriceUsd } from "../discovery/nearly.js";
import { UserFacingError, userMessage } from "../errors.js";

const WRAPPED_NEAR = "wrap.near";
const DEFAULT_SLIPPAGE_BPS = 100;
const DEX_CONTRACTS = [
  ...DEFAULT_DEX_CONTRACTS,
  ...(config.RHEA_EXTRA_CONTRACTS ?? "").split(",").map((id) => id.trim().toLowerCase()).filter(Boolean)
];
const PENDING_TTL_MS = 2 * 60 * 1000;

type PendingTrade = {
  userId: number;
  request: TradeRequest;
  quote: TradeQuote;
  expiresAt: number;
  fee?: FeePlan;
};

export type ExecutionResult = {
  status: Extract<TradeStatus, "filled" | "submitted" | "reverted" | "partial" | "unknown" | "failed">;
  txHashes: string[];
  /** The protocol fee, sent only after a verified fill. */
  fee?: { txHash: string; amount: string; contractId: string; display: string };
  /** Base units of the FT side that moved, when the fill was verified. */
  filledAmount?: string;
  reason?: string;
};

const pending = new Map<string, PendingTrade>();
const executing = new Set<number>();

type NearToken = Awaited<ReturnType<RheaClient["getNearTokens"]>>[number];

function findNearNative(tokens: readonly NearToken[]): NearToken {
  const token = tokens.find(isNearNative);
  if (!token) throw new Error("RHEA did not return NEAR in the NEAR token list");
  return token;
}

function contractOf(token: TradeRequest["tokenIn"]): string {
  const contractAddress = (token as { contractAddress?: string | null }).contractAddress;
  return stripAssetPrefix(contractAddress ?? token.address);
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

  /** Resolves a symbol or contract id to a quotable NEAR token. */
  resolveToken(query: string) {
    return this.rhea.resolveNearToken(query);
  }

  async prepare(
    userId: number,
    side: "buy" | "sell",
    tokenQuery: string,
    humanAmount: string,
    slippageBps = DEFAULT_SLIPPAGE_BPS
  ) {
    cleanupPending();

    if (!TRADING_ENABLED) {
      throw new UserFacingError("Trading uses RHEA liquidity on NEAR mainnet only; this bot is running on testnet");
    }

    const wallet = await this.walletService.getWallet(userId);
    if (!wallet) throw new UserFacingError("Create a Neyro wallet first with /wallet");

    const amountText = humanAmount.trim();
    const sellAll = side === "sell" && amountText.toLowerCase() === "all";
    if (!sellAll && (!/^\d+(\.\d+)?$/.test(amountText) || /^0+(?:\.0*)?$/.test(amountText))) {
      throw new UserFacingError('Amount must be a positive decimal number, or "all" when selling');
    }

    const token = await this.rhea.resolveNearToken(tokenQuery);
    const tokens = await this.rhea.getNearTokens();
    const near = findNearNative(tokens);
    if (isNearNative(token)) {
      throw new UserFacingError("Choose a token other than NEAR");
    }

    const tokenIn = side === "buy" ? near : token;
    const tokenOut = side === "buy" ? token : near;
    let total: bigint;
    assertSlippageAllowed(slippageBps);

    if (side === "buy") {
      total = BigInt(parseUnits(amountText, tokenIn.decimals));
      const balance = tradableNear(await getNearBalance(wallet.accountId));
      if (total > balance) {
        throw new UserFacingError(
          `Not enough NEAR: ${formatUnits(balance.toString(), 24)} NEAR available to trade (${formatUnits(config.NEAR_SPENDABLE_RESERVE_YOCTO, 24)} NEAR is kept for gas, storage and RHEA registration)`
        );
      }
      assertTradeShareAllowed(total, balance, config.MAX_TRADE_BPS_OF_BALANCE);
    } else {
      const balance = await ftBalanceOf(contractOf(tokenIn), wallet.accountId);
      total = sellAll ? balance : BigInt(parseUnits(amountText, tokenIn.decimals));
      if (total <= 0n) throw new UserFacingError(`No ${tokenIn.symbol} balance available to sell`);
      if (total > balance) {
        throw new UserFacingError(`Not enough ${tokenIn.symbol}: you hold ${formatUnits(balance.toString(), tokenIn.decimals)}`);
      }
      if (total !== balance) {
        assertTradeShareAllowed(total, balance, config.MAX_TRADE_BPS_OF_BALANCE);
      }
    }

    const fee = await this.planFee(side, BigInt(total), tokenIn);
    const amountIn = (BigInt(total) - BigInt(fee?.amount ?? "0")).toString();

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
    const expiresAt = quoteDeadline(Date.now(), PENDING_TTL_MS, quote.raw?.expiresAt ?? quote.direct?.expiresAt);

    pending.set(id, { userId, request, quote, expiresAt, fee });

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
      status: "quoted",
      expiresAt: new Date(expiresAt),
      payload: { request, quote, fee },
      feeAmount: fee?.amount,
      feeAsset: fee?.contractId
    });

    // Pool fees and price impact, measured in USD against reference prices.
    const [priceIn, priceOut] = await Promise.all([this.priceUsd(tokenIn), this.priceUsd(tokenOut)]);
    const valueLoss = estimateValueLoss(
      BigInt(amountIn), tokenIn.decimals ?? 0, priceIn,
      BigInt(quote.expectedOut), tokenOut.decimals ?? 0, priceOut
    );

    return { id, request, quote, expiresAt, unlisted: !token.listed, fee, total: total.toString(), valueLoss };
  }

  /**
   * FEE_BPS of the amount spent, capped at PROTOCOL_FEE_CAP_USD, paid in the
   * asset being spent: NEAR (as wNEAR) on buys, the token on sells.
   */
  private async planFee(side: "buy" | "sell", total: bigint, tokenIn: TradeRequest["tokenIn"]): Promise<FeePlan | undefined> {
    const treasury = config.TREASURY_ACCOUNT_ID;
    if (!treasury || FEE_BPS === 0) return undefined;

    const contractId = side === "buy" ? WRAPPED_NEAR : contractOf(tokenIn);
    const decimals = tokenIn.decimals ?? 0;
    const price = await this.priceUsd(tokenIn);
    const computed = computeFee(total, decimals, price, FEE_BPS, config.PROTOCOL_FEE_CAP_USD);
    if (!computed) {
      // Without a USD price the cap can't be enforced; don't overcharge.
      console.warn("No USD price for fee cap; trade proceeds without a fee", { contractId });
      return undefined;
    }
    if (computed.fee === 0n) return undefined;

    const registration = await storageRegistrationCost(contractId, treasury);
    return {
      side,
      treasury,
      contractId,
      amount: computed.fee.toString(),
      ...(registration > 0n ? { registerTreasury: registration.toString() } : {}),
      capped: computed.capped
    };
  }

  /** USD per NEAR, from RHEA's token list. */
  async nearUsdPrice(): Promise<number | null> {
    const tokens = await this.rhea.getNearTokens().catch((error) => {
      console.warn("RHEA token list unavailable:", String(error));
      return [];
    });
    const price = Number(tokens.find(isNearNative)?.price);
    if (Number.isFinite(price) && price > 0) return price;
    // On-chain fallback: RHEA's deepest NEAR/stablecoin DCL pool.
    return nearUsdFromDcl().catch((error) => {
      console.warn("NEAR/USD pool price unavailable:", String(error));
      return null;
    });
  }

  /**
   * Prices for the other side of a pool: NEAR, LiNEAR (by its staking rate)
   * and every token in RHEA's list that carries a USD price.
   */
  async quotePricer(): Promise<QuotePricer> {
    const [tokens, nearUsd] = await Promise.all([
      this.rhea.getNearTokens().catch(() => []),
      this.nearUsdPrice()
    ]);
    return buildQuotePricer(tokens, nearUsd);
  }

  /**
   * USD per whole token: RHEA's list, then DexScreener, then (for NEARly
   * launches DexScreener doesn't index) the token's own RHEA DCL pool.
   */
  private async priceUsd(token: TradeRequest["tokenIn"]): Promise<number | null> {
    const listed = Number((token as { price?: unknown }).price);
    if (Number.isFinite(listed) && listed > 0) return listed;
    const contractId = contractOf(token);
    const market = await fetchNearMarket(contractId).catch(() => null);
    const price = Number(market?.priceUsd);
    // A cached DexScreener price may be hours old; NEARly tokens re-price from the chain.
    const cachedPrice = Number.isFinite(price) && price > 0 ? price : null;
    if (market && market.cachedAtMs === undefined && cachedPrice !== null) return cachedPrice;
    // Stale or missing: re-price from the chain (NEARly launch pool, else any
    // RHEA DCL pool against NEAR or LiNEAR).
    const launch = isNearlyToken(contractId) ? await fetchLaunchByToken(contractId).catch(() => null) : null;
    const live = launch
      ? (await nearlyPriceUsd(launch, await this.nearUsdPrice()).catch(() => null))?.priceUsd
      : Number((await onchainMarket(contractId, await this.quotePricer()).catch(() => null))?.priceUsd);
    return live && Number.isFinite(live) && live > 0 ? live : cachedPrice;
  }

  async execute(userId: number, id: string): Promise<ExecutionResult> {
    cleanupPending();

    if (executing.has(userId)) {
      throw new UserFacingError("Another trade is still executing; wait for it to finish");
    }

    // With a database, the quoted → executing update is the single source of
    // truth: only one tap, process or replica can claim a quote. Without one,
    // fall back to this process's memory.
    const claim = await this.repository.claim(userId, id);
    const local = pending.get(id);
    pending.delete(id);

    let payload: PendingPayload | undefined;
    if (claim.kind === "claimed") {
      payload = claim.payload;
    } else if (claim.kind === "untracked" && local?.userId === userId) {
      payload = local;
    }
    if (!payload) {
      throw new UserFacingError("Trade confirmation expired or is invalid");
    }

    executing.add(userId);
    try {
      return await this.executeTrade(userId, id, payload);
    } finally {
      executing.delete(userId);
    }
  }

  private async executeTrade(userId: number, id: string, trade: PendingPayload): Promise<ExecutionResult> {
    const { request } = trade;
    const ftContract = contractOf(request.side === "buy" ? request.tokenOut : request.tokenIn);
    const before = await ftBalanceOf(ftContract, request.accountId).catch(() => undefined);

    let signer: NearAccountSigner | undefined;
    let sdkError: unknown;
    const fee = trade.fee;
    try {
      const account = await this.walletService.getSigningAccount(userId, request.accountId);
      signer = new NearAccountSigner(account, {
        allowedReceivers: [
          request.tokenIn.address,
          request.tokenOut.address
        ],
        beforeBroadcast: (txHash, receiverId) =>
          this.repository.recordEvent(userId, id, { type: "tx_signed", txHash, details: { receiverId } }),
        transform: (transactions) => {
          // Check RHEA's batch against the confirmed trade before anything
          // is signed. The fee is not part of this batch: it is charged only
          // after the swap is verified as filled (see collectFee).
          assertSwapMatchesIntent(transactions, {
            side: request.side,
            accountId: request.accountId,
            tokenIn: request.side === "buy" ? WRAPPED_NEAR : contractOf(request.tokenIn),
            tokenOut: request.side === "buy" ? contractOf(request.tokenOut) : WRAPPED_NEAR,
            amountIn: BigInt(request.amountIn),
            dexContracts: DEX_CONTRACTS
          });
          return transactions;
        }
      });
      // The trade id doubles as RHEA's idempotency key for this execution.
      await new RheaTradingEngine(signer).execute(request, trade.quote, id);
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
      // No fee is charged: the swap did not complete.
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
      // Can't prove the fill, so no fee is charged.
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
    const feeTx = fill.filled && fee ? await this.collectFee(userId, id, request.accountId, fee) : undefined;
    return {
      status,
      txHashes,
      filledAmount: fill.amount.toString(),
      reason,
      ...(feeTx && fee ? { fee: { txHash: feeTx, amount: fee.amount, contractId: fee.contractId, display: feeDisplay(request, fee) } } : {})
    };
  }

  /**
   * Sends the protocol fee once the swap is verified as filled, so a failed
   * or refunded trade never costs the user a fee. The fee amount was set
   * aside from the trade (amountIn excludes it), so the funds are there.
   * A fee that fails to send is recorded; the user's trade is unaffected.
   */
  private async collectFee(userId: number, id: string, accountId: string, fee: FeePlan): Promise<string | undefined> {
    const details = { contractId: fee.contractId, amount: fee.amount, treasury: fee.treasury };
    try {
      const account = await this.walletService.getSigningAccount(userId, accountId);
      const feeSigner = new NearAccountSigner(account, {
        allowedReceivers: [fee.contractId],
        beforeBroadcast: (txHash) => this.repository.recordEvent(userId, id, { type: "fee_tx_signed", txHash, details })
      });
      await feeSigner.signAndSendTransactions(
        [{ receiverId: fee.contractId, actions: feeActions(fee) }] as unknown as Parameters<NearAccountSigner["signAndSendTransactions"]>[0],
        {}
      );
      const sent = feeSigner.sent[0];
      if (sent?.result !== "executed") {
        await this.repository.recordEvent(userId, id, { type: "fee_uncollected", txHash: sent?.txHash, details: { ...details, result: sent?.result } });
      }
      return sent?.txHash;
    } catch (error) {
      console.error("Fee collection failed", { id, error });
      await this.repository.recordEvent(userId, id, { type: "fee_uncollected", details }).catch(() => {});
      return undefined;
    }
  }

  async cancel(userId: number, id: string): Promise<void> {
    const trade = pending.get(id);
    if (trade?.userId === userId) pending.delete(id);
    await this.repository.cancel(userId, id);
  }
}

/** "0.01 NEAR" or "1,234.5 RUST" for the receipt. */
function feeDisplay(request: TradeRequest, fee: FeePlan): string {
  if (fee.side === "buy") return `${formatUnits(fee.amount, 24)} NEAR`;
  const token = request.tokenIn as { decimals?: number; symbol?: string };
  return `${formatUnits(fee.amount, token.decimals ?? 0)} ${token.symbol ?? fee.contractId}`;
}
