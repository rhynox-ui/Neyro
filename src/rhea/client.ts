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
import { withRpcFallback } from "../near/rpc.js";
import { DCL_CONTRACT } from "../market/dcl.js";
import { fetchLaunchByToken } from "../discovery/nearly.js";
import { isValidAccountId, looksLikeContractId } from "../near/tokens.js";
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
    const contentLength = response.headers?.get?.("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > 1_000_000) {
      throw new UserFacingError("RHEA SmartRouter response is too large");
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const detail = rheaApiError(body);
      throw new UserFacingError(`RHEA SmartRouter HTTP ${response.status}${detail ? `: ${cleanRheaText(detail)}` : ""}`);
    }
    const envelope = parseSmartRouterEnvelope(body);
    if (envelope.errorCode !== undefined && envelope.errorCode !== 0) {
      throw new UserFacingError(`RHEA SmartRouter rejected route (code ${envelope.errorCode})${envelope.errorMessage ? `: ${cleanRheaText(envelope.errorMessage)}` : ""}`);
    }
    const data = extractSmartRouterPayload(envelope.data);
    if (data && typeof data.code === "number" && data.code !== 0) {
      throw new UserFacingError(`RHEA SmartRouter rejected route (code ${data.code})${typeof data.msg === "string" ? `: ${cleanRheaText(data.msg)}` : ""}`);
    }
    const amountIn = stringField(data, "amount_in", "amountIn");
    const amountOut = stringField(data, "amount_out", "amountOut");
    const reportedMinAmountOut = stringField(data, "min_amount_out", "minAmountOut", "min_output_amount", "minOutputAmount");
    // Some live SmartRouter responses omit min_amount_out even though the
    // documented response includes it. The requested slippage is already sent
    // to SmartRouter, so derive the local minimum conservatively from the
    // returned expected output rather than rejecting an otherwise valid route.
    const minAmountOut = reportedMinAmountOut || deriveMinAmountOut(amountOut, request.slippageBps);
    const msg = stringField(data, "msg", "message");
    const signature = stringField(data, "signature");
    const tokens = normalizeRouteTokens(data?.tokens ?? data?.routeTokens ?? data?.pathTokens);

    // RHEA's SmartRouter can return HTTP/business success with an empty route
    // (amount_out=0, dexs=[], tokens=[]). NEARly launches are real Rhea DCL
    // pools even when SmartRouter has not indexed the launch yet, so use the
    // launch's authoritative 1% DCL pool as a bounded fallback. Never invent
    // a quote: the fallback must return a positive on-chain DCL quote.
    if (amountOut === "0" && tokens.length === 0) {
      const dcl = await this.nearlyDclQuote(request).catch(() => null);
      if (dcl) return dcl;
      throw new UserFacingError("RHEA has no executable route for this NEARly pool right now; refresh and try again");
    }
    if (tokens.some((token) => !isValidAccountId(token))) {
      throw new UserFacingError("RHEA SmartRouter returned an invalid route token");
    }
    if (tokens.length > 16) {
      throw new UserFacingError("RHEA SmartRouter returned too many route tokens");
    }
    const missing = [
      !/^\d+$/.test(amountIn) ? "amount_in" : "",
      !/^\d+$/.test(amountOut) || BigInt(amountOut || "0") <= 0n ? "amount_out" : "",
      !/^\d+$/.test(minAmountOut) || BigInt(minAmountOut || "0") <= 0n ? "min_amount_out" : "",
      !msg ? "msg" : "",
      !signature ? "signature" : "",
      tokens.length === 0 ? "tokens" : ""
    ].filter(Boolean);
    if (msg.length > 16_384 || signature.length > 16_384) {
      throw new UserFacingError("RHEA SmartRouter returned oversized route data");
    }
    if (missing.length > 0 || BigInt(minAmountOut || "0") > BigInt(amountOut || "0")) {
      const topKeys = body ? Object.keys(body).slice(0, 20).join(",") : "none";
      const dataKeys = data ? Object.keys(data).slice(0, 20).join(",") : "none";
      throw new UserFacingError(`RHEA SmartRouter returned an incomplete route (missing: ${missing.join(",") || "valid min_amount_out"}; data keys: ${dataKeys}; response keys: ${topKeys})`);
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

  private async nearlyDclQuote(request: RheaQuoteRequest): Promise<DirectRheaNearQuote | null> {
    const candidate = isNearNative(request.fromToken) ? request.toToken : request.fromToken;
    const token = stripAssetPrefix(candidate.address);
    if (!token.endsWith(".nearlytrade.near")) return null;

    const launch = await fetchLaunchByToken(token).catch(() => null);
    if (!launch || stripAssetPrefix(launch.token) !== token || !launch.poolId || !isValidDclPoolId(launch.poolId)) {
      return null;
    }

    const inputToken = stripAssetPrefix(toApiAsset(request.fromToken).address);
    const outputToken = stripAssetPrefix(toApiAsset(request.toToken).address);

    // The launch record is authoritative for the launch pool. If its quote
    // asset is another NEARly token, that quote token itself has a DCL pool
    // against wrap.near. A NEAR/NEARly-pair buy therefore needs two pools:
    // quote-token/NEAR first, then launch-token/quote-token.
    const launchPoolId = launch.poolId;
    const quoteToken = stripAssetPrefix(launch.quote);
    const poolIds: string[] = [launchPoolId];

    if (quoteToken !== "wrap.near") {
      if (!quoteToken.endsWith(".nearlytrade.near")) return null;
      const pairLaunch = await fetchLaunchByToken(quoteToken).catch(() => null);
      if (
        !pairLaunch ||
        stripAssetPrefix(pairLaunch.token) !== quoteToken ||
        stripAssetPrefix(pairLaunch.quote) !== "wrap.near" ||
        !pairLaunch.poolId ||
        !isValidDclPoolId(pairLaunch.poolId)
      ) {
        return null;
      }

      const buyingLaunchFromNear = inputToken === "wrap.near" && outputToken === token;
      const sellingLaunchToNear = inputToken === token && outputToken === "wrap.near";
      if (buyingLaunchFromNear) {
        poolIds.splice(0, poolIds.length, pairLaunch.poolId, launchPoolId);
      } else if (sellingLaunchToNear) {
        poolIds.splice(0, poolIds.length, launchPoolId, pairLaunch.poolId);
      } else if (inputToken === quoteToken && outputToken === token) {
        poolIds.splice(0, poolIds.length, launchPoolId);
      } else if (inputToken === token && outputToken === quoteToken) {
        poolIds.splice(0, poolIds.length, launchPoolId);
      } else {
        return null;
      }
    } else if (
      !(
        (inputToken === "wrap.near" && outputToken === token) ||
        (inputToken === token && outputToken === "wrap.near")
      )
    ) {
      return null;
    }

    const raw = await withRpcFallback((provider) =>
      provider.callFunction({
        contractId: DCL_CONTRACT,
        method: "quote",
        args: {
          pool_ids: poolIds,
          // The live mainnet DCL contract expects token account IDs here.
          // Do not send the SDK's TokenMetadata objects; that ABI is rejected
          // by the deployed contract with "invalid type: map, expected a string".
          input_token: inputToken,
          output_token: outputToken,
          input_amount: request.amountIn,
          tag: null
        }
      })
    );

    const amountOut = dclQuoteAmount(raw);
    if (amountOut === null || amountOut <= 0n) return null;

    const minAmountOut = deriveMinAmountOut(amountOut.toString(), request.slippageBps);
    if (!minAmountOut || BigInt(minAmountOut) <= 0n || BigInt(minAmountOut) > amountOut) return null;

    return {
      kind: "rhea-dcl",
      amountIn: request.amountIn,
      amountOut: amountOut.toString(),
      minAmountOut,
      tokens: [inputToken, outputToken],
      poolIds,
      receivedAt: Date.now(),
      expiresAt: Date.now() + SMART_ROUTER_TTL_MS
    };
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
    if (Date.now() >= quote.expiresAt) {
      throw new UserFacingError("RHEA SmartRouter quote expired; refresh the trade and try again");
    }
    if (BigInt(quote.amountIn) !== BigInt(request.amountIn)) {
      throw new UserFacingError("RHEA SmartRouter quote input no longer matches the approved trade");
    }
    if (quote.kind === "rhea-dcl") {
      const poolIds = quote.poolIds ?? (quote.poolId ? [quote.poolId] : []);
      if (
        poolIds.length < 1 ||
        poolIds.length > 2 ||
        poolIds.some((poolId) => !isValidDclPoolId(poolId))
      ) {
        throw new UserFacingError("RHEA DCL quote has an invalid pool path; refresh the trade and try again");
      }

      const gas = poolIds.length === 2 ? "250000000000000" : "180000000000000";
      const outputToken = isNearNative(request.toToken)
        ? "wrap.near"
        : stripAssetPrefix(request.toToken.address);
      const msg = JSON.stringify({
        Swap: {
          pool_ids: poolIds,
          output_token: outputToken,
          min_output_amount: quote.minAmountOut
        }
      });
      const transfer = {
        type: "FunctionCall" as const,
        params: {
          methodName: "ft_transfer_call",
          args: { receiver_id: DCL_CONTRACT, amount: quote.amountIn, msg },
          gas,
          deposit: "1"
        }
      };

      if (isNearNative(request.fromToken)) {
        return [
          {
            receiverId: "wrap.near",
            actions: [
              {
                type: "FunctionCall" as const,
                params: {
                  methodName: "near_deposit",
                  args: {},
                  gas,
                  deposit: quote.amountIn
                }
              }
            ]
          },
          { receiverId: "wrap.near", actions: [transfer] }
        ] as NearTransaction[];
      }

      return [{
        receiverId: stripAssetPrefix(
          ((request.fromToken as AssetRef & { contractAddress?: string | null }).contractAddress)
          || request.fromToken.address
        ),
        actions: [transfer]
      }] as NearTransaction[];
    }

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


function isValidDclPoolId(poolId: string): boolean {
  const parts = poolId.split("|");
  return parts.length === 3
    && isValidAccountId(parts[0]!)
    && isValidAccountId(parts[1]!)
    && /^\\d+$/.test(parts[2]!)
    && Number(parts[2]) === 10000;
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

function parseSmartRouterEnvelope(body: Record<string, unknown> | null): {
  data: Record<string, unknown> | null;
  errorCode?: number;
  errorMessage?: string;
} {
  if (!body) return { data: null };
  const resultCode = body.result_code;
  const resultMessage = body.result_message;
  if (typeof resultCode === "number") {
    return {
      data: parseRecord(body.result_data),
      errorCode: resultCode,
      errorMessage: typeof resultMessage === "string" ? resultMessage : undefined
    };
  }
  return {
    data: body,
    errorCode: typeof body.code === "number" ? body.code : undefined,
    errorMessage: typeof body.msg === "string" ? body.msg : undefined
  };
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
  }
  return null;
}

function extractSmartRouterPayload(body: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!body) return null;
  const candidates: unknown[] = [body];
  for (const key of ["data", "result", "route"]) {
    const value = body[key];
    if (typeof value === "string") {
      try { candidates.push(JSON.parse(value)); } catch {}
    } else {
      candidates.push(value);
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if ("code" in record && typeof record.code === "number" && record.code !== 0) return record;
      if ("amount_in" in record || "amountIn" in record || "amount_out" in record || "amountOut" in record) return record;
      for (const key of ["data", "result", "route"]) {
        const nested = record[key];
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
          const nestedRecord = nested as Record<string, unknown>;
          if ("code" in nestedRecord && typeof nestedRecord.code === "number" && nestedRecord.code !== 0) return nestedRecord;
          if ("amount_in" in nestedRecord || "amountIn" in nestedRecord || "amount_out" in nestedRecord || "amountOut" in nestedRecord) return nestedRecord;
        }
      }
    }
  }
  return body;
}

function dclQuoteAmount(value: unknown): bigint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const amount = (value as Record<string, unknown>).amount;
  if (typeof amount !== "string" || !/^\\d+$/.test(amount)) return null;
  try { return BigInt(amount); } catch { return null; }
}

function deriveMinAmountOut(amountOut: string, slippageBps: number): string {
  if (!/^\d+$/.test(amountOut)) return "";
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) return "";
  const output = BigInt(amountOut);
  const minimum = (output * BigInt(10_000 - slippageBps)) / 10_000n;
  return minimum.toString();
}

function stringField(record: Record<string, unknown> | null, ...keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
  }
  return "";
}

function normalizeRouteTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tokens = value.map((item) => {
    if (typeof item === "string") return stripAssetPrefix(item);
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of ["address", "contractAddress", "token", "tokenId", "id"]) {
        if (typeof record[key] === "string") return stripAssetPrefix(record[key]);
      }
    }
    return "";
  }).filter(Boolean);
  return [...new Set(tokens)];
}

function cleanRheaText(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "[link]").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 160);
}
