import { RheaClient, isRheaUnifiedTokenNotFound } from "../rhea/client.js";
import type { TradeQuote, TradeRequest, TradingEngine } from "../domain/trading.js";
import { createNeyroNearExecutor, type NearTransactionSigner } from "../near/rhea-executor.js";
import { buildRheaRegistrationPlan, extractRheaRouteTokens, requireRheaTokenRegistration } from "../rhea/registration.js";
import { getNearBalance } from "../near/account.js";
import { config } from "../config.js";
import { UserFacingError } from "../errors.js";

export class RheaTradingEngine implements TradingEngine {
  private readonly rhea: RheaClient;
  private readonly signer?: NearTransactionSigner;

  constructor(signer?: NearTransactionSigner, rhea?: RheaClient) {
    this.signer = signer;
    this.rhea = rhea ?? new RheaClient(
      signer ? [createNeyroNearExecutor(signer)] : []
    );
  }

  async quote(request: TradeRequest): Promise<TradeQuote> {
    if (request.tokenIn.chain !== "near" || request.tokenOut.chain !== "near") {
      throw new Error("Neyro MVP supports NEAR-to-NEAR spot trading only");
    }

    const quoteRequest = {
      fromToken: request.tokenIn,
      toToken: request.tokenOut,
      amountIn: request.amountIn,
      slippageBps: request.slippageBps,
      sender: request.accountId,
      recipient: request.accountId
    };
    try {
      const quote = await this.rhea.quote(quoteRequest);
      return {
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amountIn,
        expectedOut: quote.estimatedOut,
        minAmountOut: quote.minAmountOut,
        router: quote.route?.router,
        raw: quote
      };
    } catch (error) {
      // Only fall back for the documented token-discovery miss. Do not hide
      // authentication, rate-limit, outage, or malformed-response errors.
      if (!isRheaUnifiedTokenNotFound(error)) throw error;
      const direct = await this.rhea.quoteDirect(quoteRequest);
      return {
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amountIn,
        expectedOut: direct.amountOut,
        minAmountOut: direct.minAmountOut,
        router: "rhea-smart-router",
        direct
      };
    }
  }

  private async ensureRheaRegistration(accountId: string, tokens: readonly string[]): Promise<void> {
    const uniqueTokens = [...new Set(tokens.map((token) => token.trim().toLowerCase().replace(/^nep141:/, "")).filter(Boolean))];
    this.signer?.addAllowedReceivers?.(uniqueTokens);
    this.signer?.addAllowedReceivers?.(["aggregatedex.near"]);

    const plan = await buildRheaRegistrationPlan(accountId, uniqueTokens);
    if (plan.transactions.length === 0) return;

    const balance = await getNearBalance(accountId);
    const required = plan.requiredDeposit;
    const spendableAfterRegistration = balance.available - required;
    if (spendableAfterRegistration < BigInt(config.NEAR_SPENDABLE_RESERVE_YOCTO)) {
      throw new UserFacingError(
        "RHEA token registration needs " + plan.requiredDeposit.toString() +
        " yoctoNEAR, but that would breach the " + config.NEAR_SPENDABLE_RESERVE_YOCTO.toString() +
        " yoctoNEAR safety reserve. Deposit more NEAR and retry."
      );
    }

    if (!this.signer?.signAndSendRegistrationTransactions) {
      throw new Error("RHEA registration-capable signer is required");
    }

    const sent = await this.signer.signAndSendRegistrationTransactions(plan.transactions, {});
    if (sent.txHashes.length === 0) {
      throw new UserFacingError("RHEA registration produced no transaction; trade was not submitted.");
    }

    const confirmation = await this.signer.waitForTransactions(sent.txHashes, {});
    if (confirmation.status !== "confirmed") {
      throw new UserFacingError("RHEA token registration did not confirm; trade was not submitted. Retry after checking your wallet.");
    }

    await requireRheaTokenRegistration(accountId, uniqueTokens);
  }

  async execute(
    request: TradeRequest,
    quote: TradeQuote,
    idempotencyKey?: string
  ): Promise<{ transactionHash: string }> {
    if (!this.signer) throw new Error("NEAR signer is required for RHEA execution");

    // RHEA requires route revalidation immediately before execution.
    const fresh = await this.quote(request);
    if (BigInt(fresh.minAmountOut) < BigInt(quote.minAmountOut)) {
      throw new Error("RHEA route moved against the approved minimum output; refresh the trade and confirm again");
    }

    if (fresh.direct) {
      const tokens = fresh.direct.tokens.length
        ? fresh.direct.tokens
        : [request.tokenIn.address, request.tokenOut.address];
      await this.ensureRheaRegistration(request.accountId, tokens);
      const transactions = RheaClient.directTransactions({
        fromToken: request.tokenIn,
        toToken: request.tokenOut,
        amountIn: request.amountIn,
        slippageBps: request.slippageBps,
        sender: request.accountId,
        recipient: request.accountId
      }, fresh.direct);
      const sent = await this.signer.signAndSendTransactions(transactions, {});
      const txHash = sent.txHashes[sent.txHashes.length - 1];
      if (!txHash) throw new Error("RHEA SmartRouter execution completed without a transaction hash");
      return { transactionHash: txHash };
    }

    if (!fresh.raw) throw new Error("Trade quote has no executable route");
    const tokens = extractRheaRouteTokens(
      fresh.raw,
      [request.tokenIn.address, request.tokenOut.address]
    );

    await this.ensureRheaRegistration(request.accountId, tokens);

    const result = await this.rhea.swap(fresh.raw, idempotencyKey);
    const transactionHash =
      result.txHash ?? result.txHashes?.[result.txHashes.length - 1];

    if (!transactionHash) {
      throw new Error("RHEA execution completed without a transaction hash");
    }

    return { transactionHash };
  }
}
