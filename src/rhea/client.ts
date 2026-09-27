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
    const id = stripAssetPrefix(needle);
    const byId = (token: (typeof tokens)[number]) =>
      [token.address, token.assetId, token.contractAddress].some((value) => stripAssetPrefix(value) === id);
    const matches = tokens.filter((token) => byId(token) || token.symbol.toLowerCase() === needle);

    if (matches.length > 1) {
      const exactAddress = matches.find(byId);
      if (exactAddress) return { ...exactAddress, listed: true };
      throw new UserFacingError("Multiple tokens match that symbol; use the token contract/address");
    }
    if (matches[0]) return { ...matches[0], listed: true };

    // New launches (e.g. NEARly) are tradeable on RHEA pools before they
    // appear in RHEA's price list. Accept them by exact contract id only,
    // never by symbol, and verify they are NEP-141 on chain.
    if (looksLikeContractId(id)) {
      const metadata = await ftMetadata(id).catch(() => undefined);
      if (metadata) {
        return {
          chain: "near",
          address: id,
          contractAddress: id,
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
      tokenIn: toApiAsset(request.fromToken),
      tokenOut: toApiAsset(request.toToken),
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

  async swap(quote: Quote, idempotencyKey?: string) {
    return this.client.swap({
      quote,
      waitFor: "source-confirmed",
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
  }
}

/**
 * The asset as RHEA's Swap API wants it: NEAR tokens by plain contract id
 * ("usdc.token.near"), never the UI-only "nep141:" prefix, and NEAR itself
 * as wrap.near (the API's native NEAR mapping). RHEA's own token list may
 * return "nep141:..." or "near" ids, so every quote goes through this.
 */
export function toApiAsset<T extends AssetRef>(asset: T): T {
  const ref = asset as T & { contractAddress?: string | null; assetId?: string };
  const address = isNearNative(ref) ? "wrap.near" : stripAssetPrefix(ref.contractAddress || ref.address);
  return { ...asset, address };
}

/** "nep141:usdt.tether-token.near" → "usdt.tether-token.near" (RHEA/NEAR Intents asset ids). */
export function stripAssetPrefix(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^nep141:/, "");
}

/**
 * Native NEAR / wNEAR in RHEA's token list. The SDK sets `address` to the
 * API's asset id, which may be "near", "wrap.near" or "nep141:wrap.near",
 * and flags native assets with isNative.
 */
export function isNearNative(token: { isNative?: boolean; address: string; assetId?: string; contractAddress?: string | null }): boolean {
  if (token.isNative) return true;
  return [token.address, token.assetId, token.contractAddress]
    .map(stripAssetPrefix)
    .some((id) => id === "wrap.near" || id === "near");
}
