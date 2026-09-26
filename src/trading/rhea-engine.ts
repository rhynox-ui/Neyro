import { assertValidTokenId } from "../near/tokens.js";
import { RheaClient, type RheaQuoteRequest } from "../rhea/client.js";
import type { TradeQuote, TradeRequest, TradingEngine } from "../domain/trading.js";

export class RheaTradingEngine implements TradingEngine {
  constructor(private readonly rhea = new RheaClient()) {}

  async quote(request: TradeRequest): Promise<TradeQuote> {
    const tokenIn = assertValidTokenId(request.tokenIn);
    const tokenOut = assertValidTokenId(request.tokenOut);

    const payload: RheaQuoteRequest = {
      fromChain: "near",
      toChain: "near",
      tokenIn,
      tokenOut,
      amountIn: request.amountIn,
      slippage: request.slippageBps / 10_000,
      sender: request.accountId,
      recipient: request.accountId
    };

    const raw = await this.rhea.quote(payload);
    const result = raw as Record<string, unknown>;
    const expectedOut = String(result.expectedOut ?? result.amountOut ?? result.toAmount ?? "");
    if (!expectedOut) throw new Error("RHEA quote did not contain an output amount");

    return {
      tokenIn,
      tokenOut,
      amountIn: request.amountIn,
      expectedOut,
      minAmountOut: String(result.minAmountOut ?? expectedOut),
      priceImpact: result.priceImpact ? String(result.priceImpact) : undefined,
      router: result.router ? String(result.router) : "rhea",
      raw
    };
  }

  async execute(): Promise<{ transactionHash: string }> {
    throw new Error("RHEA execution is not enabled yet; quote/build/sign must be implemented together");
  }
}
