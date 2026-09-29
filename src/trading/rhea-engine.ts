import { RheaClient } from "../rhea/client.js";
import type { TradeQuote, TradeRequest, TradingEngine } from "../domain/trading.js";
import { createNeyroNearExecutor, type NearTransactionSigner } from "../near/rhea-executor.js";
import { extractRheaRouteTokens, requireRheaTokenRegistration } from "../rhea/registration.js";
import type { DirectRheaNearQuote } from "../domain/trading.js";

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
      // Rhea's current unified API can lag behind newly-created RHEA DCL
      // pools. The legacy SmartRouter is the documented on-chain route builder
      // for aggregatedex.near and is used only after the unified quote misses.
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

  async execute(
    request: TradeRequest,
    quote: TradeQuote,
    idempotencyKey?: string
  ): Promise<{ transactionHash: string }> {
    if (quote.direct) {
      if (Date.now() > quote.direct.expiresAt) {
        throw new Error("RHEA SmartRouter quote expired; refresh the trade and try again");
      }
      const tokens = quote.direct.tokens.length
        ? quote.direct.tokens
        : [request.tokenIn.address, request.tokenOut.address];
      await requireRheaTokenRegistration(request.accountId, tokens);
      if (!this.signer) throw new Error("NEAR signer is required for direct RHEA execution");
      const transactions = RheaClient.directTransactions({
        fromToken: request.tokenIn,
        toToken: request.tokenOut,
        amountIn: request.amountIn,
        slippageBps: request.slippageBps,
        sender: request.accountId,
        recipient: request.accountId
      }, quote.direct);
      const sent = await this.signer.signAndSendTransactions(transactions, {});
      const txHash = sent.txHashes[sent.txHashes.length - 1];
      if (!txHash) throw new Error("RHEA SmartRouter execution completed without a transaction hash");
      return { transactionHash: txHash };
    }

    if (!quote.raw) throw new Error("Trade quote has no executable route");
    const tokens = extractRheaRouteTokens(
      quote.raw,
      [request.tokenIn.address, request.tokenOut.address]
    );

    await requireRheaTokenRegistration(request.accountId, tokens);

    const result = await this.rhea.swap(quote.raw, idempotencyKey);
    const transactionHash =
      result.txHash ?? result.txHashes?.[result.txHashes.length - 1];

    if (!transactionHash) {
      throw new Error("RHEA execution completed without a transaction hash");
    }

    return { transactionHash };
  }
}
