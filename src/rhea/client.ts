import { config } from "../config.js";

export type RheaQuoteRequest = {
  fromChain: string;
  toChain: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage: number;
  sender: string;
  recipient: string;
};

export class RheaClient {
  constructor(
    private readonly baseUrl = config.RHEA_API_URL,
    private readonly accessToken = config.RHEA_API_TOKEN
  ) {}

  async quote(request: RheaQuoteRequest): Promise<unknown> {
    if (!this.accessToken) {
      throw new Error("RHEA_API_TOKEN is not configured");
    }

    const response = await fetch(`${this.baseUrl}/api/swap/quote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.accessToken}`
      },
      body: JSON.stringify(request)
    });

    const body = await response.json() as { code?: number; msg?: string; data?: unknown };

    if (!response.ok || body.code !== 0) {
      throw new Error(body.msg ?? `RHEA quote failed: HTTP ${response.status}`);
    }

    return body.data;
  }
}
