import test from "node:test";
import assert from "node:assert/strict";
import { assertSwapMatchesIntent, DEFAULT_DEX_CONTRACTS, TradePolicyError } from "../src/trading/policy.js";
import { functionCall } from "../src/near/actions.js";
import { userMessage } from "../src/errors.js";

const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const ME = "a".repeat(64);
const MEME = "meme-1.nearlytrade.near";

const buy = { side: "buy" as const, accountId: ME, tokenIn: "wrap.near", tokenOut: MEME, amountIn: 5n * NEAR, dexContracts: DEFAULT_DEX_CONTRACTS };
const sell = { side: "sell" as const, accountId: ME, tokenIn: MEME, tokenOut: "wrap.near", amountIn: 1000n, maxNativeWithdraw: 5n, dexContracts: DEFAULT_DEX_CONTRACTS };

const buyBatch = () => [
  { receiverId: MEME, actions: [functionCall("storage_deposit", { account_id: ME, registration_only: true }, 10n * TGAS, 1_250_000_000_000_000_000_000n)] },
  { receiverId: "wrap.near", actions: [
    functionCall("near_deposit", {}, 10n * TGAS, 5n * NEAR),
    functionCall("ft_transfer_call", { receiver_id: "dclv2.ref-labs.near", amount: (5n * NEAR).toString(), msg: "{}" }, 180n * TGAS, 1n)
  ] }
];
const sellBatch = () => [
  { receiverId: MEME, actions: [functionCall("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: "1000", msg: "{}" }, 180n * TGAS, 1n)] },
  { receiverId: "wrap.near", actions: [functionCall("near_withdraw", { amount: "5" }, 10n * TGAS, 1n)] }
];

const blocked = (run: () => void, pattern: RegExp) =>
  assert.throws(run, (error) => error instanceof TradePolicyError && pattern.test(error.message));

test("normal buy and sell batches pass", () => {
  assert.doesNotThrow(() => assertSwapMatchesIntent(buyBatch(), buy));
  assert.doesNotThrow(() => assertSwapMatchesIntent(sellBatch(), sell));
});

test("tokens can only go to allowlisted DEX contracts, up to the agreed amount", () => {
  const redirected = buyBatch();
  redirected[1]!.actions[1] = functionCall("ft_transfer_call", { receiver_id: "attacker.near", amount: "1", msg: "" }, 1n, 1n);
  blocked(() => assertSwapMatchesIntent(redirected, buy), /sends tokens to attacker\.near/);

  const tooMuchUnwrap = sellBatch();
  tooMuchUnwrap[1]!.actions[0] = functionCall("near_withdraw", { amount: "6" }, 1n, 1n);
  blocked(() => assertSwapMatchesIntent(tooMuchUnwrap, sell), /unwraps more native NEAR/);

  const tooMuch = sellBatch();
  tooMuch[0]!.actions[0] = functionCall("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: "1001", msg: "" }, 1n, 1n);
  blocked(() => assertSwapMatchesIntent(tooMuch, sell), /more than the confirmed amount/);

  const wrongToken = [{ receiverId: "usdt.tether-token.near", actions: [functionCall("ft_transfer_call", { receiver_id: "v2.ref-finance.near", amount: "1" }, 1n, 1n)] }];
  blocked(() => assertSwapMatchesIntent(wrongToken, sell), /unexpected contract usdt/);
});

test("arbitrary DEX methods are never signed", () => {
  blocked(
    () => assertSwapMatchesIntent(
      [{ receiverId: "aggregatedex.near", actions: [functionCall("withdraw", {}, 1n, 0n)] }],
      sell
    ),
    /unexpected call withdraw/
  );
});

test("NEAR can't leave except as the agreed wrap and small storage deposits", () => {
  blocked(() => assertSwapMatchesIntent([{ receiverId: "wrap.near", actions: [{ type: "Transfer", params: { deposit: "1" } }] }], buy), /plain NEAR transfer/);

  const overWrap = buyBatch();
  overWrap[1]!.actions[0] = functionCall("near_deposit", {}, 1n, 6n * NEAR);
  blocked(() => assertSwapMatchesIntent(overWrap, buy), /wraps more NEAR/);

  blocked(() => assertSwapMatchesIntent([{ receiverId: "wrap.near", actions: [functionCall("near_deposit", {}, 1n, 1n)] }], sell), /unexpected NEAR wrap/);
  blocked(() => assertSwapMatchesIntent([{ receiverId: "wrap.near", actions: [functionCall("near_withdraw", { amount: "1" }, 1n, 1n)] }], buy), /unexpected unwrap/);

  const bigStorage = buyBatch();
  bigStorage[0]!.actions[0] = functionCall("storage_deposit", { account_id: ME }, 1n, NEAR);
  blocked(() => assertSwapMatchesIntent(bigStorage, buy), /storage deposit is too large/);

  const otherAccount = buyBatch();
  otherAccount[0]!.actions[0] = functionCall("storage_deposit", { account_id: "someone.near" }, 1n, 1n);
  blocked(() => assertSwapMatchesIntent(otherAccount, buy), /another account/);

  blocked(() => assertSwapMatchesIntent([{ receiverId: "v2.ref-finance.near", actions: [functionCall("withdraw", {}, 1n, NEAR)] }], sell), /unexpected call withdraw/);
});

test("policy reasons reach the user through SDK error wrappers", () => {
  try {
    assertSwapMatchesIntent([{ receiverId: "evil.near", actions: [] }], buy);
  } catch (error) {
    const wrapped = Object.assign(new Error("Failed to sign or broadcast NEAR transactions"), { cause: error });
    assert.match(userMessage(wrapped, "fallback"), /unexpected contract evil\.near/);
  }
});

test("RHEA service errors show RHEA's own explanation, internal ones don't", async () => {
  const { SwapSdkError } = await import("@rhea-finance/cross-chain-aggregation-dex");
  const service = new SwapSdkError("API_ERROR", "quote" as never, "Token not supported: https://x.y/z", { details: { apiCode: 4001 } });
  assert.equal(userMessage(service, "Unable to create a quote"), 'Unable to create a quote: RHEA says "Token not supported: [link]" (code 4001)');
  const internal = new SwapSdkError("API_ERROR", "quote" as never, "fetch failed at https://rpc/secret");
  assert.equal(userMessage(internal, "Unable to create a quote"), "Unable to create a quote (RHEA: API_ERROR)");
  assert.match(userMessage(new SwapSdkError("ROUTE_NOT_FOUND", "quote" as never, "x"), "Q"), /no swap route/);
});
