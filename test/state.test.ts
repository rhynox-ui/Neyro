process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.NODE_ENV ??= "test";
import test from "node:test";
import assert from "node:assert/strict";
const { InMemoryStateStore } = await import("../src/state/store.js");

test("in-memory take consumes a value exactly once", async () => {
  const store = new InMemoryStateStore();
  await store.set(7, "confirm", { value: "x" }, 60_000);
  const [a, b] = await Promise.all([
    store.take<{ value: string }>(7, "confirm"),
    store.take<{ value: string }>(7, "confirm")
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
});

test("expired in-memory values cannot be taken", async () => {
  const store = new InMemoryStateStore();
  await store.set(7, "expired", { value: "x" }, -1);
  assert.equal(await store.take(7, "expired"), null);
});
