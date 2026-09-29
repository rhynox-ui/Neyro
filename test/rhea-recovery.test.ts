process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.NODE_ENV = "test";
process.env.NEAR_NETWORK = "mainnet";
process.env.NEAR_RPC_URL = "https://rpc.mainnet.fastnear.com";
process.env.DATABASE_URL = "https://example.com/test-db";

import test from "node:test";
import assert from "node:assert/strict";

const { parseRheaInternalBalances, buildRheaWithdrawTransaction } =
  await import("../src/rhea/recovery.js");

test("RHEA recovery parser normalizes nested balances", () => {
  assert.deepEqual(
    parseRheaInternalBalances({
      data: [
        { token: "nep141:wrap.near", amount: "100" },
        { token_id: "token.near", balance: "20" },
        { token: "token.near", amount: "30" }
      ]
    }),
    [
      { token: "wrap.near", amount: "100" },
      { token: "token.near", amount: "50" }
    ]
  );
});

test("RHEA recovery withdrawal targets only AggregateDex", () => {
  const tx = buildRheaWithdrawTransaction("nep141:wrap.near");
  assert.equal(tx.receiverId, "aggregatedex.near");
  const action = tx.actions[0] as any;
  assert.equal(action.params.methodName, "withdraw");
  assert.equal(action.params.args.token, "wrap.near");
  assert.equal(action.params.args.return_near, true);
  assert.equal(action.params.gas, "30000000000000");
  assert.equal(action.params.deposit, "0");
});

test("RHEA recovery rejects AggregateDex as a token", () => {
  assert.throws(() => buildRheaWithdrawTransaction("aggregatedex.near"), /Invalid RHEA recovery token/);
});
