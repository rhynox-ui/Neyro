import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { formatCreatorFee } = await import("../src/launch/fees.js");

test("formats NEARly creator token fees using 18 decimals", () => {
  assert.equal(
    formatCreatorFee({ amount: "1000000000000000000", decimals: 18 }),
    "1"
  );
});

test("formats pair creator fees using the pair's decimals", () => {
  assert.equal(
    formatCreatorFee({ amount: "123456", decimals: 6 }),
    "0.123456"
  );
});


const { buildCreatorFeeClaimTransaction } = await import("../src/launch/fees.js");

test("builds only approved NEARly creator fee claim methods", () => {
  const near = buildCreatorFeeClaimTransaction("near");
  assert.equal(near.receiverId, "nearlytrade.near");
  assert.equal(near.actions[0]?.action.functionCall?.methodName, "claim_creator_fees");

  const token = buildCreatorFeeClaimTransaction("token", 2256);
  assert.equal(token.receiverId, "nearlytrade.near");
  assert.equal(token.actions[0]?.action.functionCall?.methodName, "claim_creator_token_fees");
  assert.equal(token.actions[0]?.action.functionCall?.args, JSON.stringify({ launch_id: 2256 }));

  const quote = buildCreatorFeeClaimTransaction("quote", 2256);
  assert.equal(quote.receiverId, "nearlytrade.near");
  assert.equal(quote.actions[0]?.action.functionCall?.methodName, "claim_creator_quote_fees");
});

test("rejects malformed launch ids before signing", () => {
  assert.throws(() => buildCreatorFeeClaimTransaction("token", -1), /Invalid NEARly launch id/);
  assert.throws(() => buildCreatorFeeClaimTransaction("quote", undefined), /Invalid NEARly launch id/);
});
