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

  async resolveNearToken(query: string) {
    const needle = query.trim().toLowerCase();
    if (!needle) throw new Error("Token is required");

    const tokens = await this.getNearTokens();
    const matches = tokens.filter((token) =>
      token.address.toLowerCase() === needle ||
      token.assetId.toLowerCase() === needle ||
      token.contractAddress?.toLowerCase() === needle ||
      token.symbol.toLowerCase() === needle
    );

    if (matches.length === 0) {
      throw new Error("Token was not found in RHEA's current NEAR token list");
    }

    if (matches.length > 1) {
      const exactAddress = matches.find((token) =>
        token.address.toLowerCase() === needle ||
        token.assetId.toLowerCase() === needle ||
        token.contractAddress?.toLowerCase() === needle
      );
      if (exactAddress) return exactAddress;
      throw new Error("Multiple tokens match that symbol; use the token contract/address");
    }

    return matches[0];
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

    try {
      return await this.client.quote(payload);
    } catch (error) {
      if (
        error instanceof Error &&
        /token .*not found on chain/i.test(error.message)
      ) {
        throw new Error(
          `RHEA currently cannot quote ${request.toToken.address} on NEAR. ` +
          "The token may be visible in RHEA discovery but not yet indexed for routing. No transaction was submitted."
        );
      }
      throw error;
    }
  }

  async swap(quote: Quote, idempotencyKey?: string) {
    return this.client.swap({
      quote,
      waitFor: "source-confirmed",
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
  }
}
