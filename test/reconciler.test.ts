import test from "node:test";
import assert from "node:assert/strict";
import {
  STALE_EXECUTING_MS,
  TX_VALIDITY_MS,
  decideResolution,
  reconcileOnce
} from "../src/trading/reconciler.js";
import { NoopTradeRepository, type TradeStatusUpdate, type UnresolvedTrade } from "../src/trading/repository.js";
import type { TxLookup } from "../src/near/execution.js";

const executed: TxLookup = { result: "executed" };
const unknown: TxLookup = { result: "unknown" };
const reverted: TxLookup = { result: "reverted", failure: "E68: slippage error" };

test("no journaled hashes means nothing was broadcast", () => {
  assert.deepEqual(decideResolution([], 0), { status: "failed" });
});

test("on-chain results settle the trade", () => {
  assert.deepEqual(decideResolution([executed, executed], 0), { status: "submitted" });
  assert.deepEqual(decideResolution([executed, reverted], 0), { status: "partial" });
});

test("reverted-only batches preserve the on-chain failure", () => {
  assert.deepEqual(
    decideResolution([reverted], 0),
    { status: "reverted", failure: "E68: slippage error" }
  );
});

test("a reverted transaction does not settle while another hash is unknown", () => {
  assert.equal(decideResolution([reverted, unknown], TX_VALIDITY_MS - 1), undefined);
  assert.deepEqual(
    decideResolution([reverted, unknown], TX_VALIDITY_MS),
    { status: "failed" }
  );
});

test("unseen hashes wait until the transaction can no longer land", () => {
  assert.equal(decideResolution([unknown], TX_VALIDITY_MS - 1), undefined);
  assert.deepEqual(decideResolution([unknown], TX_VALIDITY_MS), { status: "failed" });
  assert.deepEqual(decideResolution([executed, unknown], TX_VALIDITY_MS), { status: "partial" });
});

class FakeRepository extends NoopTradeRepository {
  resolved: Array<{ key: string; update: TradeStatusUpdate }> = [];
  constructor(private readonly trades: UnresolvedTrade[], private readonly winner = true) { super(); }
  override async listUnresolved(staleMs: number) {
    assert.equal(staleMs, STALE_EXECUTING_MS);
    return this.trades;
  }
  override async resolve(_userId: number, key: string, update: TradeStatusUpdate) {
    this.resolved.push({ key, update });
    return this.winner;
  }
}

const trade = (key: string, txHashes: string[], ageMs = 0): UnresolvedTrade => ({
  telegramUserId: 7,
  idempotencyKey: key,
  accountId: "alice.near",
  status: "unknown",
  updatedAt: new Date(1_000_000 - ageMs),
  txHashes
});

test("reconcileOnce resolves settled trades, notifies users, and leaves pending ones", async () => {
  const repository = new FakeRepository([
    trade("landed", ["h1"]),
    trade("pending", ["h2"]),
    trade("rpc-down", ["h3"])
  ]);
  const messages: string[] = [];
  const results: Record<string, TxLookup | Error> = { h1: executed, h2: unknown, h3: new Error("rpc down") };

  const count = await reconcileOnce({
    repository,
    lookup: async (hash) => {
      const result = results[hash]!;
      if (result instanceof Error) throw result;
      return result;
    },
    notify: async (_user, text) => { messages.push(text); },
    explorerLink: (hash) => `https://nearblocks.io/txns/${hash}`,
    now: () => 1_000_000
  });

  assert.equal(count, 1);
  assert.deepEqual(repository.resolved.map((item) => [item.key, item.update.status]), [["landed", "submitted"]]);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /executed on chain/);
  assert.match(messages[0]!, /txns\/h1/);
});

test("unresolved fee transactions are reconciled without double-recording", async () => {
  const repository = new (class extends NoopTradeRepository {
    resolutions: Array<{ key: string; txHash: string; status: "collected" | "failed" }> = [];
    override async listUnresolvedFees() {
      return [{
        telegramUserId: 7,
        idempotencyKey: "fee-landed",
        accountId: "alice.near",
        txHash: "fee1",
        details: { amount: "123" },
        createdAt: new Date(1_000_000)
      }];
    }
    override async recordFeeResolution(_userId: number, key: string, txHash: string, status: "collected" | "failed") {
      this.resolutions.push({ key, txHash, status });
      return true;
    }
  })();

  const count = await reconcileOnce({
    repository,
    lookup: async () => executed,
    notify: async () => {},
    explorerLink: (hash) => hash,
    now: () => 1_000_000
  });

  assert.equal(count, 1);
  assert.deepEqual(repository.resolutions, [
    { key: "fee-landed", txHash: "fee1", status: "collected" }
  ]);
});

test("unknown fee transactions stay unresolved until their validity window expires", async () => {
  const repository = new (class extends NoopTradeRepository {
    resolutions: Array<{ status: "collected" | "failed" }> = [];
    override async listUnresolvedFees() {
      return [{
        telegramUserId: 7,
        idempotencyKey: "fee-unknown",
        accountId: "alice.near",
        txHash: "fee2",
        details: { amount: "123" },
        createdAt: new Date(1_000_000)
      }];
    }
    override async recordFeeResolution(_userId: number, _key: string, _txHash: string, status: "collected" | "failed") {
      this.resolutions.push({ status });
      return true;
    }
  })();

  const count = await reconcileOnce({
    repository,
    lookup: async () => unknown,
    notify: async () => {},
    explorerLink: (hash) => hash,
    now: () => 1_000_000 + TX_VALIDITY_MS - 1
  });

  assert.equal(count, 0);
  assert.deepEqual(repository.resolutions, []);
});

test("a trade another worker already resolved is not announced twice", async () => {
  const repository = new FakeRepository([trade("landed", ["h1"])], false);
  const messages: string[] = [];
  const count = await reconcileOnce({
    repository,
    lookup: async () => executed,
    notify: async (_user, text) => { messages.push(text); },
    explorerLink: (hash) => hash
  });
  assert.equal(count, 0);
  assert.deepEqual(messages, []);
});
