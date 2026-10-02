import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { TradingService } = await import("../src/trading/service.js");
const { NoopTradeRepository } = await import("../src/trading/repository.js");
const { UserFacingError } = await import("../src/errors.js");

class ClaimOnceRepository extends NoopTradeRepository {
  claims = 0;
  cancelled: string[] = [];
  override async claim() {
    this.claims++;
    return { kind: "unavailable" as const };
  }
  override async cancel(_userId: number, key: string) {
    this.cancelled.push(key);
  }
}

test("execute refuses a quote the repository will not hand out", async () => {
  const repository = new ClaimOnceRepository();
  const service = new TradingService(undefined, undefined, repository);
  await assert.rejects(service.execute(1, "0123456789abcdef"), (error) =>
    error instanceof UserFacingError && /expired or is invalid/.test(error.message)
  );
  assert.equal(repository.claims, 1);
});

test("without persistence, execute refuses unknown quotes", async () => {
  const service = new TradingService(undefined, undefined, new NoopTradeRepository());
  await assert.rejects(service.execute(1, "fedcba9876543210"), UserFacingError);
});

test("cancel is delegated to the repository", async () => {
  const repository = new ClaimOnceRepository();
  const service = new TradingService(undefined, undefined, repository);
  await service.cancel(1, "0123456789abcdef");
  assert.deepEqual(repository.cancelled, ["0123456789abcdef"]);
});

test("builds safe direct Rhea DCL transactions for NEARly pools", async () => {
  const { RheaClient } = await import("../src/rhea/client.js");
  const quote = {
    kind: "rhea-dcl" as const,
    amountIn: "100000000000000000000000",
    amountOut: "1900000000000000000000000",
    minAmountOut: "1881000000000000000000000",
    tokens: ["wrap.near", "babyninu.nearlytrade.near"],
    poolIds: ["babyninu.nearlytrade.near|wrap.near|10000"],
    receivedAt: Date.now(),
    expiresAt: Date.now() + 30_000
  };
  const txs = RheaClient.directTransactions({
    fromToken: { chain: "near", address: "wrap.near", isNative: true, decimals: 24 } as never,
    toToken: { chain: "near", address: "babyninu.nearlytrade.near", decimals: 18 } as never,
    amountIn: quote.amountIn,
    slippageBps: 100,
    sender: "alice.near",
    recipient: "alice.near"
  }, quote);
  assert.equal(txs.length, 2);
  assert.equal(txs[0]?.receiverId, "wrap.near");
  assert.equal(txs[1]?.receiverId, "wrap.near");
  const transfer = (txs[1]!.actions[0] as any).params;
  assert.equal(transfer.methodName, "ft_transfer_call");
  assert.equal(transfer.args.receiver_id, "dclv2.ref-labs.near");
  const msg = JSON.parse(transfer.args.msg);
  assert.deepEqual(msg.Swap.pool_ids, ["babyninu.nearlytrade.near|wrap.near|10000"]);
  assert.equal(msg.Swap.output_token, "babyninu.nearlytrade.near");
  assert.equal(msg.Swap.min_output_amount, quote.minAmountOut);
  assert.equal(transfer.gas, "180000000000000");
  assert.equal(transfer.deposit, "1");
});

test("quotes send RHEA plain contract ids: no nep141: prefix, NEAR as wrap.near", async () => {
  const { toApiAsset } = await import("../src/rhea/client.js");
  assert.equal(toApiAsset({ chain: "near", address: "nep141:wrap.near", isNative: true } as never).address, "wrap.near");
  assert.equal(toApiAsset({ chain: "near", address: "near", isNative: true } as never).address, "wrap.near");
  assert.equal(toApiAsset({ chain: "near", address: "nep141:usdt.tether-token.near", contractAddress: null, isNative: false } as never).address, "usdt.tether-token.near");
  assert.equal(toApiAsset({ chain: "near", address: "rust-334.meme-cooking.near", isNative: false } as never).address, "rust-334.meme-cooking.near");
});


test("builds a two-pool DCL transaction path for NEARly pair launches", async () => {
  const { RheaClient } = await import("../src/rhea/client.js");
  const quote = {
    kind: "rhea-dcl" as const,
    amountIn: "100000000000000000000000",
    amountOut: "1900000000000000000000000",
    minAmountOut: "1881000000000000000000000",
    tokens: ["wrap.near", "ninu-4.nearlytrade.near", "babyninu.nearlytrade.near"],
    poolIds: [
      "ninu-4.nearlytrade.near|wrap.near|10000",
      "babyninu.nearlytrade.near|ninu-4.nearlytrade.near|10000"
    ],
    receivedAt: Date.now(),
    expiresAt: Date.now() + 30_000
  };
  const txs = RheaClient.directTransactions({
    fromToken: { chain: "near", address: "wrap.near", isNative: true, decimals: 24 } as never,
    toToken: { chain: "near", address: "babyninu.nearlytrade.near", decimals: 18 } as never,
    amountIn: quote.amountIn,
    slippageBps: 100,
    sender: "alice.near",
    recipient: "alice.near"
  }, quote);
  const transfer = (txs[1]!.actions[0] as any).params;
  const msg = JSON.parse(transfer.args.msg);
  assert.deepEqual(msg.Swap.pool_ids, quote.poolIds);
  assert.equal(transfer.gas, "250000000000000");
  assert.equal((txs[0]!.actions[0] as any).params.gas, "250000000000000");
});

test("accepts valid numeric RHEA direct quote amounts", async () => {
  const { RheaTradingEngine } = await import("../src/trading/rhea-engine.js");
  const fakeRhea = {
    quoteDirect: async () => ({
      kind: "rhea-dcl" as const,
      amountIn: "100000000000000000000000",
      amountOut: "2000000000000000000000000",
      minAmountOut: "1980000000000000000000000",
      tokens: ["wrap.near", "babyninu.nearlytrade.near"],
      poolIds: ["babyninu.nearlytrade.near|wrap.near|10000"],
      receivedAt: Date.now(),
      expiresAt: Date.now() + 30_000
    })
  } as any;

  const engine = new RheaTradingEngine(undefined, fakeRhea);
  const quote = await engine.quote({
    accountId: "alice.near",
    side: "buy",
    tokenIn: { chain: "near", address: "wrap.near", isNative: true, decimals: 24 } as never,
    tokenOut: { chain: "near", address: "babyninu.nearlytrade.near", decimals: 18 } as never,
    amountIn: "100000000000000000000000",
    slippageBps: 100
  });

  assert.equal(quote.expectedOut, "2000000000000000000000000");
  assert.equal(quote.minAmountOut, "1980000000000000000000000");
});
