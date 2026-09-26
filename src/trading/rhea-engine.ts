import { RheaClient } from "../rhea/client.js";
import type { TradeQuote, TradeRequest, TradingEngine } from "../domain/trading.js";
import { createNeyroNearExecutor, type NearTransactionSigner } from "../near/rhea-executor.js";

export class RheaTradingEngine implements TradingEngine {
  private readonly rhea: RheaClient;

  constructor(signer?: NearTransactionSigner, rhea?: RheaClient) {
    this.rhea = rhea ?? new RheaClient(
      signer ? [createNeyroNearExecutor(signer)] : []
    );
  }

  async quote(request: TradeRequest): Promise<TradeQuote> {
    if (request.tokenIn.chain !== "near" || request.tokenOut.chain !== "near") {
      throw new Error("Neyro MVP supports NEAR-to-NEAR spot trading only");
    }

    const quote = await this.rhea.quote({
      fromToken: request.tokenIn,
      toToken: request.tokenOut,
      amountIn: request.amountIn,
      slippageBps: request.slippageBps,
      sender: request.accountId,
      recipient: request.accountId
    });

    return {
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amountIn,
      expectedOut: quote.estimatedOut,
      minAmountOut: quote.minAmountOut,
      router: quote.route?.router,
      raw: quote
    };
  }

  async execute(
    _request: TradeRequest,
    quote: TradeQuote,
    idempotencyKey?: string
  ): Promise<{ transactionHash: string }> {
    const result = await this.rhea.swap(quote.raw, idempotencyKey);
    const transactionHash = result.txHash ?? result.txHashes?.[result.txHashes.length - 1];

    if (!transactionHash) {
      throw new Error("RHEA execution completed without a transaction hash");
    }

    return { transactionHash };
  }
}
