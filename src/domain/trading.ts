import type {
  AssetRef,
  Quote as RheaQuote
} from "@rhea-finance/cross-chain-aggregation-dex";

export type TradeSide = "buy" | "sell";

export type DirectRheaNearQuote = {
  kind: "rhea-smart-router" | "rhea-dcl";
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  msg?: string;
  signature?: string;
  tokens: string[];
  /** Authoritative Rhea DCL pool id for direct NEARly execution. */
  poolId?: string;
  receivedAt: number;
  expiresAt: number;
};

export type TradeQuote = {
  tokenIn: AssetRef;
  tokenOut: AssetRef;
  amountIn: string;
  expectedOut: string;
  minAmountOut: string;
  priceImpact?: string;
  router?: string;
  /** The immutable SDK quote used later by RHEA swap(), when available. */
  raw?: RheaQuote;
  /** Legacy NEAR SmartRouter quote used for fresh/unlisted RHEA DCL tokens. */
  direct?: DirectRheaNearQuote;
};

export type TradeRequest = {
  accountId: string;
  side: TradeSide;
  tokenIn: AssetRef;
  tokenOut: AssetRef;
  amountIn: string;
  slippageBps: number;
  /** Immutable NEARly buy tax applied after Rhea's pool min-output check. */
  outputTaxBps?: number;
};

export interface TradingEngine {
  quote(request: TradeRequest): Promise<TradeQuote>;
  execute(request: TradeRequest, quote: TradeQuote, idempotencyKey?: string): Promise<{ transactionHash: string }>;
}
