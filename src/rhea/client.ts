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
import type { DirectRheaNearQuote } from "../domain/trading.js";
import type { NearTransaction } from "@rhea-finance/cross-chain-aggregation-dex";

/** A NEAR token Neyro can quote. `listed` is false for tokens only verified on chain. */
export type NearToken = AssetRef & {
  address: string;
  symbol: string;
  decimals: number;
  contractAddress: string | null;
  listed: boolean;
};

const SMART_ROUTER_URL = "https://smartx.rhea.finance/swapMultiDexPath";
const SMART_ROUTER_TIMEOUT_MS = 10_000;
const SMART_ROUTER_TTL_MS = 45_000;

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

    try {
      return await this.client.quote(payload);
    } catch (error) {
      throw error;
    }
  }

  async smartRouterQuote(request: RheaQuoteRequest): Promise<DirectRheaNearQuote> {
    const tokenIn = toApiAsset(request.fromToken).address;
    const tokenOut = toApiAsset(request.toToken).address;
    const url = new URL(SMART_ROUTER_URL);
    url.searchParams.set("amountIn", request.amountIn);
    url.searchParams.set("tokenIn", tokenIn);
    url.searchParams.set("tokenOut", tokenOut);
    url.searchParams.set("slippage", String(request.slippageBps / 10_000));
    url.searchParams.set("user", request.sender);
    url.searchParams.set("receiveUser", request.recipient);
    url.searchParams.set("skipUnwrapNativeToken", "false");

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(SMART_ROUTER_TIMEOUT_MS)
      });
    } catch (error) {
      throw new UserFacingError(`RHEA SmartRouter request failed: ${cleanRheaText(error instanceof Error ? error.message : "network error")}`);
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const detail = rheaApiError(body);
      throw new UserFacingError(`RHEA SmartRouter HTTP ${response.status}${detail ? `: ${cleanRheaText(detail)}` : ""}`);
    }
    if (body && typeof body.code === "number" && body.code !== 0) {
      throw new UserFacingError(`RHEA SmartRouter rejected route (code ${body.code})${typeof body.msg === "string" ? `: ${cleanRheaText(body.msg)}` : ""}`);
    }
    const data = body?.data && typeof body.data === "object" ? body.data as Record<string, unknown> : body;
    if (data && typeof data.code === "number" && data.code !== 0) {
      throw new UserFacingError(`RHEA SmartRouter rejected route (code ${data.code})${typeof data.msg === "string" ? `: ${cleanRheaText(data.msg)}` : ""}`);
    }
    const amountIn = String(data?.amount_in ?? "");
    const amountOut = String(data?.amount_out ?? "");
    const minAmountOut = String(data?.min_amount_out ?? "");
    const msg = typeof data?.msg === "string" ? data.msg : "";
    const signature = typeof data?.signature === "string" ? data.signature : "";
    const tokens = Array.isArray(data?.tokens) ? data.tokens.filter((item): item is string => typeof item === "string").map(stripAssetPrefix) : [];
    const missingRouteFields = [
      /^\d+$/.test(amountIn) ? null : "amount_in",
      /^\d+$/.test(amountOut) && BigInt(amountOut) > 0n ? null : "amount_out",
      /^\d+$/.test(minAmountOut) && BigInt(minAmountOut) > 0n ? null : "min_amount_out",
      minAmountOut && amountOut && BigInt(minAmountOut) <= BigInt(amountOut) ? null : "min_amount_out>amount_out",
      msg ? null : "msg",
      signature ? null : "signature",
      tokens.length > 0 ? null : "tokens"
    ].filter((value): value is string => value !== null);
    if (missingRouteFields.length > 0) {
      console.error("RHEA SmartRouter route shape rejected", {
        keys: data ? Object.keys(data) : [],
        fieldTypes: {
          amount_in: typeof data?.amount_in,
          amount_out: typeof data?.amount_out,
          min_amount_out: typeof data?.min_amount_out,
          msg: typeof data?.msg,
          signature: typeof data?.signature,
          tokens: Array.isArray(data?.tokens) ? "array" : typeof data?.tokens
        },
        amountIn,
        amountOut,
        minAmountOut,
        tokenCount: tokens.length,
        tokenSample: tokens.slice(0, 8),
        missingRouteFields
      });
      throw new UserFacingError("RHEA SmartRouter returned an incomplete route");
    }
    if (BigInt(amountIn) !== BigInt(request.amountIn)) throw new UserFacingError("RHEA SmartRouter changed the requested input amount");
    const expectedInput = stripAssetPrefix(tokenIn);
    const expectedOutput = stripAssetPrefix(tokenOut);
    const routeTokens = new Set(tokens.map(stripAssetPrefix));
    if (!routeTokens.has(expectedInput) || !routeTokens.has(expectedOutput)) {
      throw new UserFacingError("RHEA SmartRouter returned a route that does not contain the requested tokens");
    }
    return { kind: "rhea-smart-router", amountIn, amountOut, minAmountOut, msg, signature, tokens, receivedAt: Date.now(), expiresAt: Date.now() + SMART_ROUTER_TTL_MS };
  }

  async quoteDirect(request: RheaQuoteRequest): Promise<DirectRheaNearQuote> {
    return this.smartRouterQuote(request);
  }

  async swap(quote: Quote, idempotencyKey?: string) {
    return this.client.swap({
      quote,
      waitFor: "source-confirmed",
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
  }

  static directTransactions(request: RheaQuoteRequest, quote: DirectRheaNearQuote): NearTransaction[] {
    const msg = JSON.stringify({ msg: quote.msg, signature: quote.signature });
    const transfer = {
      type: "FunctionCall" as const,
      params: {
        methodName: "ft_transfer_call",
        args: { receiver_id: "aggregatedex.near", amount: quote.amountIn, msg },
        gas: "300000000000000",
        deposit: "1"
      }
    };
    if (isNearNative(request.fromToken)) {
      return [
        {
          receiverId: "wrap.near",
          actions: [{ type: "FunctionCall", params: { methodName: "near_deposit", args: {}, gas: "300000000000000", deposit: quote.amountIn } }]
        },
        { receiverId: "wrap.near", actions: [transfer] }
      ] as NearTransaction[];
    }
    return [{ receiverId: stripAssetPrefix(((request.fromToken as AssetRef & { contractAddress?: string | null }).contractAddress) || request.fromToken.address), actions: [transfer] }] as NearTransaction[];
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


function rheaApiError(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  for (const key of ["message", "msg", "error"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
  }
  return undefined;
}

export function isRheaUnifiedTokenNotFound(error: unknown): boolean {
  return error instanceof Error && /token .*not found on chain/i.test(error.message);
}

function cleanRheaText(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "[link]").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 160);
}
