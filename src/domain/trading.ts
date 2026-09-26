export type TradeSide = "buy" | "sell";

export type TradeQuote = {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedOut: string;
  minAmountOut: string;
  priceImpact?: string;
  router?: string;
  raw: unknown;
};

export type TradeRequest = {
  accountId: string;
  side: TradeSide;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageBps: number;
};

export interface TradingEngine {
  quote(request: TradeRequest): Promise<TradeQuote>;
  execute(request: TradeRequest, quote: TradeQuote): Promise<{ transactionHash: string }>;
}
