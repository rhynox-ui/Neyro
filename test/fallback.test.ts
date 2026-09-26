import test from "node:test";
import assert from "node:assert/strict";
import { InvalidNonceError } from "near-api-js/rpc-errors";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
const { firstSuccess, resetCooldowns } = await import("../src/net/fallback.js");
const { buildRpcEndpoints } = await import("../src/near/rpc.js");

const quiet = async <T>(run: () => Promise<T>) => {
  const warn = console.warn;
  console.warn = () => {};
  try { return await run(); } finally { console.warn = warn; }
};

test("first healthy source wins; failures move to the back for a while", async () => {
  resetCooldowns();
  let now = 0;
  const calls: string[] = [];
  const sources = [
    { name: "a", run: async () => { calls.push("a"); throw new Error("429"); } },
    { name: "b", run: async () => { calls.push("b"); return "B"; } }
  ];
  assert.equal(await quiet(() => firstSuccess(sources, { now: () => now, cooldownMs: 1000 })), "B");
  assert.deepEqual(calls, ["a", "b"]);

  calls.length = 0;
  assert.equal(await firstSuccess(sources, { now: () => now, cooldownMs: 1000 }), "B");
  assert.deepEqual(calls, ["b"], "a is cooling down, so b goes first");

  now = 2000;
  calls.length = 0;
  await quiet(() => firstSuccess(sources, { now: () => now, cooldownMs: 1000 }));
  assert.deepEqual(calls, ["a", "b"], "after the cooldown a is tried first again");
});

test("definitive errors stop at once and keep their type", async () => {
  resetCooldowns();
  const calls: string[] = [];
  const rejection = new InvalidNonceError(1, 1, "h", "b");
  await assert.rejects(
    firstSuccess([
      { name: "x", run: async () => { calls.push("x"); throw rejection; } },
      { name: "y", run: async () => { calls.push("y"); return 1; } }
    ], { isDefinitive: (error) => error instanceof InvalidNonceError }),
    (error) => error === rejection
  );
  assert.deepEqual(calls, ["x"]);
});

test("misses fall through to the next source; all misses return a miss", async () => {
  resetCooldowns();
  const isMiss = (value: unknown) => value === null;
  assert.equal(await firstSuccess([{ name: "m1", run: async () => null }, { name: "m2", run: async () => "hit" }], { isMiss }), "hit");
  assert.equal(await firstSuccess([{ name: "m3", run: async () => null }], { isMiss }), null);
  await assert.rejects(quiet(() => firstSuccess([{ name: "e1", run: async () => { throw new Error("down"); } }])), /down/);
});

test("RPC endpoint list keeps configured ones first and drops duplicates", () => {
  const endpoints = buildRpcEndpoints("https://rpc.mainnet.fastnear.com", "https://near.drpc.org", [
    "https://rpc.mainnet.fastnear.com/", "https://rpc.intea.rs"
  ]);
  assert.deepEqual(endpoints.map((e) => e.name), ["primary", "fallback", "rpc.intea.rs"]);
});

test("signing provider fails over on errors but not on definitive rejections", async () => {
  resetCooldowns();
  const { RPC_ENDPOINTS, createRpcProvider, createFailoverProvider } = await import("../src/near/rpc.js");
  const [first, second] = RPC_ENDPOINTS.map((endpoint) => createRpcProvider(endpoint.url)) as unknown as Record<string, unknown>[];
  const calls: string[] = [];
  first!.viewAccount = async () => { calls.push("first"); throw new Error("fetch failed"); };
  second!.viewAccount = async () => { calls.push("second"); return { amount: 1n }; };
  const rejection = new InvalidNonceError(1, 1, "h", "b");
  first!.sendTransactionUntil = async () => { calls.push("send-first"); throw rejection; };
  second!.sendTransactionUntil = async () => { calls.push("send-second"); return {}; };

  const provider = createFailoverProvider() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  assert.deepEqual(await quiet(() => provider.viewAccount!({ accountId: "a.near" })), { amount: 1n });
  resetCooldowns(); // "first" is cooling down after the failure above
  await assert.rejects(provider.sendTransactionUntil!({}, "FINAL"), (error) => error === rejection);
  assert.deepEqual(calls, ["first", "second", "send-first"]);
});
