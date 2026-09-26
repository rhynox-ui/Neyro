import { config } from "../config.js";

export type RheaQuoteRequest = {
  fromChain: string;
  toChain: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageBps: number;
  sender: string;
  recipient: string;
};

type ApiEnvelope<T> = {
  code: number;
  msg: string;
  data: T;
};

export type RheaToken = {
  address: string;
  chainId: number;
  decimals: number;
  symbol: string;
  name?: string;
  price?: string;
  logoURI?: string;
};

export class RheaClient {
  constructor(
    private readonly baseUrl = config.RHEA_API_URL,
    private readonly accessToken = config.RHEA_API_TOKEN
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {})
    };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers ?? {}) }
    });

    const body = await response.json() as ApiEnvelope<T>;
    if (!response.ok || body.code !== 0) {
      throw new Error(body.msg || `RHEA API error: HTTP ${response.status}`);
    }
    return body.data;
  }

  async getNearTokens(): Promise<Record<string, RheaToken>> {
    const data = await this.request<Record<string, RheaToken>>(
      "/get_chain_prices?chain=900001",
      { method: "GET" }
    );
    return data;
  }

  async quote(request: RheaQuoteRequest): Promise<unknown> {
    return this.request<unknown>("/api/v2/swap/quote", {
      method: "POST",
      body: JSON.stringify({
        fromChain: request.fromChain,
        toChain: request.toChain,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amountIn,
        slippageBps: request.slippageBps,
        sender: request.sender,
        recipient: request.recipient,
        quoteWaitingTimeMs: 3000,
        sameChainTimeoutMs: 500,
        crossChainTimeoutMs: 3000
      })
    });
  }
}
