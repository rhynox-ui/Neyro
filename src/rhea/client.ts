import {
  SwapClient,
  type AssetRef,
  type Quote,
  type QuoteRequest,
  type ChainExecutor
} from "@rhea-finance/cross-chain-aggregation-dex";
import { config } from "../config.js";
import { UserFacingError } from "../errors.js";
import { ftMetadata } from "../near/ft.js";
import { looksLikeContractId } from "../near/tokens.js";

/** A NEAR token Neyro can quote. `listed` is false for tokens only verified on chain. */
export type NearToken = AssetRef & {
  address: string;
  symbol: string;
  decimals: number;
  contractAddress: string | null;
  listed: boolean;
};

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

  async resolveNearToken(query: string): Promise<NearToken> {
    const needle = query.trim().toLowerCase();
    if (!needle) throw new UserFacingError("Token is required");

    const tokens = await this.getNearTokens();
    const matches = tokens.filter((token) =>
      token.address.toLowerCase() === needle ||
      token.assetId.toLowerCase() === needle ||
      token.contractAddress?.toLowerCase() === needle ||
      token.symbol.toLowerCase() === needle
    );

    if (matches.length > 1) {
      const exactAddress = matches.find((token) =>
        token.address.toLowerCase() === needle ||
        token.assetId.toLowerCase() === needle ||
        token.contractAddress?.toLowerCase() === needle
      );
      if (exactAddress) return { ...exactAddress, listed: true };
      throw new UserFacingError("Multiple tokens match that symbol; use the token contract/address");
    }
    if (matches[0]) return { ...matches[0], listed: true };

    // New launches (e.g. NEARly) are tradeable on RHEA pools before they
    // appear in RHEA's price list. Accept them by exact contract id only,
    // never by symbol, and verify they are NEP-141 on chain.
    if (looksLikeContractId(needle)) {
      const metadata = await ftMetadata(needle).catch(() => undefined);
      if (metadata) {
        return {
          chain: "near",
          address: needle,
          contractAddress: needle,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
          isNative: false,
          listed: false
        };
      }
      throw new UserFacingError("That contract is not a NEP-141 token on NEAR");
    }

    throw new UserFacingError("Token was not found; for new tokens use the full contract id (e.g. token.near)");
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
