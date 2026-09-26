import type {
  AssetRef,
  Quote as RheaQuote
} from "@rhea-finance/cross-chain-aggregation-dex";

export type TradeSide = "buy" | "sell";

export type TradeQuote = {
  tokenIn: AssetRef;
  tokenOut: AssetRef;
  amountIn: string;
  expectedOut: string;
  minAmountOut: string;
  priceImpact?: string;
  router?: string;
  /** The immutable SDK quote used later by RHEA swap(). */
  raw: RheaQuote;
};

export type TradeRequest = {
  accountId: string;
  side: TradeSide;
  tokenIn: AssetRef;
  tokenOut: AssetRef;
  amountIn: string;
  slippageBps: number;
};

export interface TradingEngine {
  quote(request: TradeRequest): Promise<TradeQuote>;
  execute(request: TradeRequest, quote: TradeQuote, idempotencyKey?: string): Promise<{ transactionHash: string }>;
}
