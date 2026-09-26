import {
  SwapClient,
  type AssetRef,
  type Quote,
  type QuoteRequest,
  type ChainExecutor
} from "@rhea-finance/cross-chain-aggregation-dex";
import { config } from "../config.js";

export type RheaQuoteRequest = {
  fromToken: AssetRef;
  toToken: AssetRef;
  amountIn: string;
  slippageBps: number;
  sender: string;
  recipient: string;
};

export class RheaClient {
  private readonly client: SwapClient;

  constructor(executors: readonly ChainExecutor[] = []) {
    this.client = new SwapClient({
      baseUrl: config.RHEA_API_URL,
      apiKey: config.RHEA_API_TOKEN,
      timeoutMs: 15_000,
      executors
    });
  }

  async getNearTokens() {
    return this.client.getFromTokens({ chainId: 900001 });
  }

  async quote(request: RheaQuoteRequest): Promise<Quote> {
    const payload: QuoteRequest = {
      fromChain: "near",
      toChain: "near",
      tokenIn: request.fromToken,
      tokenOut: request.toToken,
      amountIn: request.amountIn,
      slippageBps: request.slippageBps,
      sender: request.sender,
      recipient: request.recipient,
      quoteWaitingTimeMs: 3000,
      sameChainTimeoutMs: 500,
      crossChainTimeoutMs: 3000
    };

    return this.client.quote(payload);
  }

  async swap(quote: Quote) {
    return this.client.swap({
      quote,
      waitFor: "source-confirmed"
    });
  }
}
