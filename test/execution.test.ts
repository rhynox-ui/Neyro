import test from "node:test";
import assert from "node:assert/strict";
import { InvalidNonceError, TransactionTimeoutError } from "near-api-js/rpc-errors";
import type { Account } from "near-api-js";
import type { NearTransaction } from "@rhea-finance/cross-chain-aggregation-dex";
import { findExecutionFailure } from "../src/near/execution.js";
import { NearAccountSigner } from "../src/wallet/near-account-signer.js";
import { assessFill, classifyBatch, quoteDeadline } from "../src/trading/outcome.js";

const success = { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] };
const refunded = {
  // ft_transfer_call returns successfully even though the DEX receipt failed.
  status: { SuccessValue: "IjAi" },
  receipts_outcome: [
    { outcome: { status: { SuccessReceiptId: "a" } } },
    { outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "E68: slippage error" } } } } } } },
    { outcome: { status: { SuccessValue: "IjAi" } } }
  ]
};

test("findExecutionFailure detects receipt-level failures under a successful top-level status", () => {
  assert.equal(findExecutionFailure(success), undefined);
  assert.match(findExecutionFailure(refunded) ?? "", /slippage error/);
  assert.ok(findExecutionFailure({ status: { Failure: "boom" } }));
  assert.ok(findExecutionFailure(undefined));
});

type Step = { outcome?: unknown; error?: unknown };

function fakeAccount(steps: Step[], log: string[]): Account {
  let n = 0;
  return {
    accountId: "alice.near",
    async createSignedTransaction({ receiverId }: { receiverId: string }) {
      const index = n;
      return { transaction: { encode: () => new TextEncoder().encode(`${receiverId}:${index}`) }, index };
    },
    provider: {
      async sendTransactionUntil(signed: { index: number }) {
        log.push(`send:${signed.index}`);
        const step = steps[n++];
        if (step?.error) throw step.error;
        return step?.outcome;
      }
    }
  } as unknown as Account;
}

const call = { type: "FunctionCall", params: { methodName: "ft_transfer_call", args: { amount: "1" }, gas: "30000000000000", deposit: "1" } };
const tx = (receiverId: string): NearTransaction => ({ receiverId, actions: [call] } as unknown as NearTransaction);

test("signer journals each hash before broadcast and confirms executed batches", async () => {
  const log: string[] = [];
  const signer = new NearAccountSigner(fakeAccount([{ outcome: success }, { outcome: success }], log), {
    beforeBroadcast: async (hash) => { log.push(`journal:${hash.length > 0}`); }
  });
  const { txHashes } = await signer.signAndSendTransactions([tx("a.near"), tx("b.near")], {});
  assert.deepEqual(log, ["journal:true", "send:0", "journal:true", "send:1"]);
  assert.equal(txHashes.length, 2);
  assert.deepEqual(await signer.waitForTransactions(txHashes, {}).then((r) => r.status), "confirmed");
  assert.equal(classifyBatch(signer.sent), "executed");
});

test("signer reports a refunded swap as failed and stops the batch", async () => {
  const log: string[] = [];
  const signer = new NearAccountSigner(fakeAccount([{ outcome: refunded }, { outcome: success }], log));
  const { txHashes } = await signer.signAndSendTransactions([tx("swap.near"), tx("next.near")], {});
  assert.deepEqual(log, ["send:0"]);
  assert.equal((await signer.waitForTransactions(txHashes, {})).status, "failed");
  assert.equal(classifyBatch(signer.sent), "reverted");
});

test("a timeout after broadcast is unknown, never failed", async () => {
  const signer = new NearAccountSigner(fakeAccount([{ error: new TransactionTimeoutError() }], []));
  await assert.rejects(signer.signAndSendTransactions([tx("swap.near")], {}));
  assert.equal(signer.sent[0]?.result, "unknown");
  assert.equal(classifyBatch(signer.sent), "unknown");
});

test("an RPC rejection is a safe-to-retry failure", async () => {
  const signer = new NearAccountSigner(fakeAccount([{ error: new InvalidNonceError(1, 1, "h", "b") }], []));
  await assert.rejects(signer.signAndSendTransactions([tx("swap.near")], {}));
  assert.equal(classifyBatch(signer.sent), "failed");
});

test("a journal failure prevents broadcast", async () => {
  const log: string[] = [];
  const signer = new NearAccountSigner(fakeAccount([{ outcome: success }], log), {
    beforeBroadcast: async () => { throw new Error("db down"); }
  });
  await assert.rejects(signer.signAndSendTransactions([tx("swap.near")], {}), /db down/);
  assert.deepEqual(log, []);
  assert.equal(classifyBatch(signer.sent), "failed");
});

test("classifyBatch distinguishes partial execution", () => {
  assert.equal(classifyBatch([
    { txHash: "1", receiverId: "a", result: "executed" },
    { txHash: "2", receiverId: "b", result: "rejected" }
  ]), "partial");
});

test("assessFill uses the FT side of the trade", () => {
  assert.deepEqual(assessFill("buy", 10n, 25n), { filled: true, amount: 15n });
  assert.deepEqual(assessFill("buy", 10n, 10n), { filled: false, amount: 0n });
  assert.deepEqual(assessFill("sell", 50n, 20n), { filled: true, amount: 30n });
  assert.deepEqual(assessFill("sell", 50n, 50n), { filled: false, amount: 0n });
});

test("quoteDeadline honours RHEA expiry in seconds or milliseconds, capped by the max TTL", () => {
  const now = 1_700_000_000_000;
  assert.equal(quoteDeadline(now, 120_000), now + 120_000);
  assert.equal(quoteDeadline(now, 120_000, (now + 30_000) / 1000), now + 30_000);
  assert.equal(quoteDeadline(now, 120_000, now + 30_000), now + 30_000);
  assert.equal(quoteDeadline(now, 120_000, now + 600_000), now + 120_000);
});

test("signer refuses non-swap actions before signing anything", async () => {
  const log: string[] = [];
  const signer = new NearAccountSigner(fakeAccount([{ outcome: success }], log));
  const addKey = { receiverId: "alice.near", actions: [{ type: "AddKey", params: {} }] } as unknown as NearTransaction;
  await assert.rejects(signer.signAndSendTransactions([tx("swap.near"), addKey], {}), /Refusing to sign/);
  assert.deepEqual(log, []);
  assert.equal(classifyBatch(signer.sent), "failed");
});
