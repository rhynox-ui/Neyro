import { RheaClient } from "../rhea/client.js";
import type { TradeQuote, TradeRequest, TradingEngine } from "../domain/trading.js";

export class RheaTradingEngine implements TradingEngine {
  constructor(private readonly rhea = new RheaClient()) {}

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
      raw: quote.raw
    };
  }

  async execute(): Promise<{ transactionHash: string }> {
    throw new Error("Execution is intentionally gated until the secure NEAR signer executor is connected");
  }
}
