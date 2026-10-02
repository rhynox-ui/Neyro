import { RheaClient, isRheaUnifiedTokenNotFound } from "../rhea/client.js";
import type { TradeQuote, TradeRequest, TradingEngine } from "../domain/trading.js";
import { createNeyroNearExecutor, type NearTransactionSigner } from "../near/rhea-executor.js";
import { buildRheaRegistrationPlan, extractRheaRouteTokens, requireRheaTokenRegistration } from "../rhea/registration.js";
import { getNearBalance } from "../near/account.js";
import { config } from "../config.js";
import { UserFacingError } from "../errors.js";
import { applyBuyTax } from "./tax.js";

function applyOutputTax(amount: string, taxBps = 0): string {
  if (!/^\\d+$/.test(amount)) throw new UserFacingError("RHEA returned an invalid quote amount; refresh and try again");
  if (!taxBps) return amount;
  const taxed = applyBuyTax(BigInt(amount), taxBps);
  if (taxed <= 0n) throw new UserFacingError("The quoted output is too small after NEARly tax; increase the trade size or refresh");
  return taxed.toString();
}

export class RheaTradingEngine implements TradingEngine {
  private readonly rhea: RheaClient;
  private readonly signer?: NearTransactionSigner;

  constructor(signer?: NearTransactionSigner, rhea?: RheaClient) {
    this.signer = signer;
    this.rhea = rhea ?? new RheaClient(
      signer ? [createNeyroNearExecutor(signer)] : []
    );
  }

  async quote(request: TradeRequest): Promise<TradeQuote> {
    if (request.tokenIn.chain !== "near" || request.tokenOut.chain !== "near") {
      throw new Error("Neyro MVP supports NEAR-to-NEAR spot trading only");
    }

    const quoteRequest = {
      fromToken: request.tokenIn,
      toToken: request.tokenOut,
      amountIn: request.amountIn,
      slippageBps: request.slippageBps,
      sender: request.accountId,
      recipient: request.accountId
    };
    // RHEA's current NEAR SmartRouter is the documented same-chain quote
    // path. The unified SDK can call the older findPath service, which may
    // return 404 even while SmartRouter is healthy. Use SmartRouter first.
    try {
      const direct = await this.rhea.quoteDirect(quoteRequest);
      if (
        BigInt(direct.amountOut) <= 0n ||
        BigInt(direct.minAmountOut) <= 0n ||
        BigInt(direct.minAmountOut) > BigInt(direct.amountOut)
      ) {
        throw new UserFacingError("RHEA returned an invalid quote; refresh and try again");
      }
      return {
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amountIn,
        expectedOut: applyOutputTax(direct.amountOut, request.outputTaxBps),
        minAmountOut: applyOutputTax(direct.minAmountOut, request.outputTaxBps),
        router: "rhea-smart-router",
        direct
      };
    } catch (directError) {
      // Only use the unified SDK as a fallback for token-discovery misses.
      // Do not hide SmartRouter outages, malformed responses, or HTTP errors.
      if (!isRheaUnifiedTokenNotFound(directError)) throw directError;
      const quote = await this.rhea.quote(quoteRequest);
      if (
        !/^\d+$/.test(quote.estimatedOut) ||
        !/^\d+$/.test(quote.minAmountOut) ||
        BigInt(quote.estimatedOut) <= 0n ||
        BigInt(quote.minAmountOut) <= 0n ||
        BigInt(quote.minAmountOut) > BigInt(quote.estimatedOut)
      ) {
        throw new UserFacingError("RHEA returned an invalid quote; refresh and try again");
      }
      return {
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amountIn,
        expectedOut: applyOutputTax(quote.estimatedOut, request.outputTaxBps),
        minAmountOut: applyOutputTax(quote.minAmountOut, request.outputTaxBps),
        router: quote.route?.router,
        raw: quote
      };
    }
  }

  private async ensureRheaRegistration(accountId: string, tokens: readonly string[]): Promise<void> {
    const uniqueTokens = [...new Set(tokens.map((token) => token.trim().toLowerCase().replace(/^nep141:/, "")).filter(Boolean))];
    if (uniqueTokens.length > 16) {
      throw new UserFacingError("RHEA route requires too many token registrations; refresh the quote and try again.");
    }
    this.signer?.addAllowedReceivers?.(uniqueTokens);
    this.signer?.addAllowedReceivers?.(["aggregatedex.near"]);

    const plan = await buildRheaRegistrationPlan(accountId, uniqueTokens);
    if (plan.transactions.length === 0) return;

    const balance = await getNearBalance(accountId);
    const required = plan.requiredDeposit;
    const maxAutoRegistration = BigInt(config.MAX_AUTO_RHEA_REGISTRATION_YOCTO);
    if (required > maxAutoRegistration) {
      throw new UserFacingError(
        "RHEA token registration would require " + plan.requiredDeposit.toString() +
        " yoctoNEAR, above Neyro's automatic registration limit of " +
        config.MAX_AUTO_RHEA_REGISTRATION_YOCTO + " yoctoNEAR. Register the route tokens manually or refresh the trade."
      );
    }
    const spendableAfterRegistration = balance.available - required;
    if (spendableAfterRegistration < BigInt(config.NEAR_SPENDABLE_RESERVE_YOCTO)) {
      throw new UserFacingError(
        "RHEA token registration needs " + plan.requiredDeposit.toString() +
        " yoctoNEAR, but that would breach the " + config.NEAR_SPENDABLE_RESERVE_YOCTO.toString() +
        " yoctoNEAR safety reserve. Deposit more NEAR and retry."
      );
    }

    if (!this.signer?.signAndSendRegistrationTransactions) {
      throw new Error("RHEA registration-capable signer is required");
    }

    const sent = await this.signer.signAndSendRegistrationTransactions(plan.transactions, {});
    if (sent.txHashes.length === 0) {
      throw new UserFacingError("RHEA registration produced no transaction; trade was not submitted.");
    }

    const confirmation = await this.signer.waitForTransactions(sent.txHashes, {});
    if (confirmation.status !== "confirmed") {
      throw new UserFacingError("RHEA token registration did not confirm; trade was not submitted. Retry after checking your wallet.");
    }

    await requireRheaTokenRegistration(accountId, uniqueTokens);
  }

  async execute(
    request: TradeRequest,
    quote: TradeQuote,
    idempotencyKey?: string
  ): Promise<{ transactionHash: string }> {
    if (!this.signer) throw new Error("NEAR signer is required for RHEA execution");

    // RHEA requires route revalidation immediately before execution.
    const fresh = await this.quote(request);
    if (BigInt(fresh.minAmountOut) < BigInt(quote.minAmountOut)) {
      throw new Error("RHEA route moved against the approved minimum output; refresh the trade and confirm again");
    }

    if (fresh.direct) {
      const tokens = fresh.direct.tokens.length
        ? fresh.direct.tokens
        : [request.tokenIn.address, request.tokenOut.address];
      await this.ensureRheaRegistration(request.accountId, tokens);
      const transactions = RheaClient.directTransactions({
        fromToken: request.tokenIn,
        toToken: request.tokenOut,
        amountIn: request.amountIn,
        slippageBps: request.slippageBps,
        sender: request.accountId,
        recipient: request.accountId
      }, fresh.direct);
      const sent = await this.signer.signAndSendTransactions(transactions, {});
      const txHash = sent.txHashes[sent.txHashes.length - 1];
      if (!txHash) throw new Error("RHEA SmartRouter execution completed without a transaction hash");
      return { transactionHash: txHash };
    }

    if (!fresh.raw) throw new Error("Trade quote has no executable route");
    const tokens = extractRheaRouteTokens(
      fresh.raw,
      [request.tokenIn.address, request.tokenOut.address]
    );

    await this.ensureRheaRegistration(request.accountId, tokens);

    const result = await this.rhea.swap(fresh.raw, idempotencyKey);
    const transactionHash =
      result.txHash ?? result.txHashes?.[result.txHashes.length - 1];

    if (!transactionHash) {
      throw new Error("RHEA execution completed without a transaction hash");
    }

    return { transactionHash };
  }
}
