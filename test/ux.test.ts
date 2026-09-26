import test from "node:test";
import assert from "node:assert/strict";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.NEAR_RPC_URL = "https://rpc.primary.example";
process.env.NEAR_RPC_FALLBACK_URL = "https://rpc.fallback.example";

const { escapeHtml, renderBalance, renderExecution, renderPortfolio } = await import("../src/bot/register.js");
const { parseFastNearTokens } = await import("../src/portfolio/service.js");
const { parseFtMetadata } = await import("../src/near/ft.js");
const { GAS_RESERVE_YOCTO, nearBalanceFromView, tradableNear } = await import("../src/near/account.js");
const { withRpcFallback } = await import("../src/near/rpc.js");

const NEAR = 10n ** 24n;

test("NEAR balance excludes storage staking and keeps a gas reserve", () => {
  const balance = nearBalanceFromView({ amount: 2n * NEAR, locked: 0n, storage_usage: 182 });
  assert.equal(balance.storage, 182n * 10n ** 19n);
  assert.equal(balance.available, 2n * NEAR - 182n * 10n ** 19n);
  assert.equal(tradableNear(balance), balance.available - GAS_RESERVE_YOCTO);
  assert.equal(tradableNear(nearBalanceFromView({ amount: 1n, locked: 0n, storage_usage: 100 })), 0n);
});

test("renderBalance shows human units and unfunded accounts", () => {
  assert.equal(renderBalance({ exists: false, total: 0n, storage: 0n, available: 0n }), "0 NEAR (not funded yet)");
  assert.equal(renderBalance({ exists: true, total: 3n * NEAR, storage: 0n, available: 3n * NEAR }), "3 NEAR");
});

test("HTML rendering escapes token-controlled text", () => {
  assert.equal(escapeHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
  const text = renderPortfolio(
    { exists: true, total: NEAR, storage: 0n, available: NEAR },
    [{ symbol: "<script>", contractId: "evil.near", decimals: 0, balance: "5", balanceBaseUnits: "5" }]
  );
  assert.ok(!text.includes("<script>"));
  assert.match(text, /&lt;script&gt;/);
});

test("renderExecution never tells users to retry an unknown outcome", () => {
  const unknown = renderExecution({ status: "unknown", txHashes: ["abcdefghijk"] });
  assert.match(unknown, /Do not retry/);
  assert.match(unknown, /txns\/abcdefghijk/);
  assert.match(renderExecution({ status: "failed", txHashes: [], reason: "<x>" }), /&lt;x&gt;/);
});

test("parseFastNearTokens keeps positive integer balances only", () => {
  assert.deepEqual(parseFastNearTokens({
    account_id: "alice.near",
    tokens: [
      { contract_id: "usdt.tether-token.near", balance: "1500000", last_update_block_height: 1 },
      { contract_id: "zero.near", balance: "0", last_update_block_height: null },
      { contract_id: "null.near", balance: null },
      { contract_id: "empty.near", balance: "" }
    ]
  }), [{ contractId: "usdt.tether-token.near", balance: 1_500_000n }]);
  assert.throws(() => parseFastNearTokens({ nope: true }));
});

test("parseFtMetadata validates NEP-141 metadata", () => {
  assert.deepEqual(
    parseFtMetadata("token.near", { spec: "ft-1.0.0", symbol: "TKN", name: "Token", decimals: 18 }),
    { contractId: "token.near", symbol: "TKN", name: "Token", decimals: 18 }
  );
  assert.throws(() => parseFtMetadata("nft.near", { spec: "nft-1.0.0", symbol: "X", decimals: 0 }));
  assert.throws(() => parseFtMetadata("bad.near", { spec: "ft-1.0.0", symbol: "X", decimals: 1.5 }));
});

test("RPC failover does not retry definitive answers", async () => {
  let calls = 0;
  await assert.rejects(withRpcFallback(async () => {
    calls++;
    throw new AccountDoesNotExistError("x.near", "hash", 1);
  }), AccountDoesNotExistError);
  assert.equal(calls, 1);
});

test("contract-id detection accepts NEAR contracts but not bare symbols", async () => {
  const { looksLikeContractId, isValidAccountId } = await import("../src/near/tokens.js");
  assert.ok(looksLikeContractId("meme.nearly.near"));
  assert.ok(looksLikeContractId("a".repeat(64).replace(/a/g, "f")));
  assert.ok(!looksLikeContractId("usdc"));
  assert.ok(!looksLikeContractId("bad..near"));
  assert.ok(!isValidAccountId("UPPER.near"));
  assert.ok(!isValidAccountId("-lead.near"));
});

test("rate limiter allows a burst up to the limit per key, then recovers", async () => {
  const { RateLimiter } = await import("../src/bot/rate-limit.js");
  let now = 0;
  const limiter = new RateLimiter(3, 1000, () => now);
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.take("a")), [true, true, true, false]);
  assert.equal(limiter.take("b"), true, "other users are unaffected");
  now = 1001;
  assert.equal(limiter.take("a"), true);
});
