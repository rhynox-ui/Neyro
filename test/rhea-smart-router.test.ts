process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.NEAR_NETWORK ??= "mainnet";
process.env.NEAR_RPC_URL ??= "https://rpc.mainnet.fastnear.com";
process.env.DATABASE_URL ??= "https://example.com/test-db";

import test from "node:test";
import assert from "node:assert/strict";
import { RheaClient, type RheaQuoteRequest } from "../src/rhea/client.js";

const request: RheaQuoteRequest = {
  fromToken: { chain: "near", address: "wrap.near", symbol: "NEAR", decimals: 24, isNative: true },
  toToken: { chain: "near", address: "shore-4lzt.launch.shoremarkets.near", symbol: "SHORE", decimals: 18 },
  amountIn: "100000000000000000000000",
  slippageBps: 100,
  sender: "alice.near",
  recipient: "alice.near"
};

test("direct RHEA SmartRouter quote normalizes the documented response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    amount_in: request.amountIn,
    amount_out: "123456789",
    min_amount_out: "122000000",
    msg: "route-message",
    signature: "route-signature",
    tokens: ["wrap.near", "shore-4lzt.launch.shoremarkets.near"]
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const quote = await new RheaClient().quoteDirect(request);
    assert.equal(quote.kind, "rhea-smart-router");
    assert.equal(quote.amountIn, request.amountIn);
    assert.equal(quote.amountOut, "123456789");
    assert.equal(quote.minAmountOut, "122000000");
    assert.deepEqual(quote.tokens, ["wrap.near", "shore-4lzt.launch.shoremarkets.near"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct RHEA buy builds wrap then aggregated DEX transfer", () => {
  const quote = {
    kind: "rhea-smart-router" as const,
    amountIn: request.amountIn,
    amountOut: "123456789",
    minAmountOut: "122000000",
    msg: "route-message",
    signature: "route-signature",
    tokens: ["wrap.near", "shore-4lzt.launch.shoremarkets.near"],
    receivedAt: Date.now(),
    expiresAt: Date.now() + 30_000
  };
  const transactions = RheaClient.directTransactions(request, quote);
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0]?.receiverId, "wrap.near");
  assert.equal(transactions[1]?.receiverId, "wrap.near");
  const deposit = transactions[0]?.actions[0] as any;
  const transfer = transactions[1]?.actions[0] as any;
  assert.equal(deposit.params.methodName, "near_deposit");
  assert.equal(deposit.params.deposit, request.amountIn);
  assert.equal(transfer.params.methodName, "ft_transfer_call");
  assert.equal(transfer.params.args.receiver_id, "aggregatedex.near");
  assert.equal(transfer.params.args.amount, request.amountIn);
  assert.deepEqual(JSON.parse(transfer.params.args.msg), { msg: "route-message", signature: "route-signature" });
});

test("direct RHEA sell sends the input token to aggregated DEX", () => {
  const sellRequest: RheaQuoteRequest = {
    ...request,
    fromToken: { chain: "near", address: "shore-4lzt.launch.shoremarkets.near", symbol: "SHORE", decimals: 18 },
    toToken: { chain: "near", address: "wrap.near", symbol: "NEAR", decimals: 24 }
  };
  const quote = {
    kind: "rhea-smart-router" as const,
    amountIn: "1000000000000000000",
    amountOut: "9000000000000000000000",
    minAmountOut: "8910000000000000000000",
    msg: "route-message",
    signature: "route-signature",
    tokens: ["shore-4lzt.launch.shoremarkets.near", "wrap.near"],
    receivedAt: Date.now(),
    expiresAt: Date.now() + 30_000
  };
  const [transaction] = RheaClient.directTransactions(sellRequest, quote);
  assert.equal(transaction?.receiverId, "shore-4lzt.launch.shoremarkets.near");
  assert.equal((transaction?.actions[0] as any).params.methodName, "ft_transfer_call");
  assert.equal((transaction?.actions[0] as any).params.args.receiver_id, "aggregatedex.near");
});
