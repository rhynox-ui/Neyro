import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
const { trackScreen, keepScreen, deleteIncoming } = await import("../src/bot/screens.js");
const { InMemoryStateStore } = await import("../src/state/store.js");

function fakeCtx(deleted: number[], chatType = "private") {
  return {
    from: { id: 7 },
    chat: { id: 70, type: chatType },
    message: { message_id: 999 },
    api: { deleteMessage: async (_chat: number, id: number) => { deleted.push(id); return true; } },
    deleteMessage: async () => { deleted.push(999); return true; }
  } as never;
}

test("a new screen replaces the previous one of the same kind only", async () => {
  const store = new InMemoryStateStore();
  const deleted: number[] = [];
  const ctx = fakeCtx(deleted);
  await trackScreen(ctx, "wallet", 70, 1, store);
  await trackScreen(ctx, "settings", 70, 2, store);
  await trackScreen(ctx, "wallet", 70, 3, store);
  assert.deepEqual(deleted, [1], "old wallet screen deleted, settings kept");
});

test("kept screens (receipts) are never deleted later", async () => {
  const store = new InMemoryStateStore();
  const deleted: number[] = [];
  const ctx = fakeCtx(deleted);
  await trackScreen(ctx, "panel", 70, 10, store);
  await keepScreen(ctx, "panel", store);
  await trackScreen(ctx, "panel", 70, 11, store);
  assert.deepEqual(deleted, []);
});

test("user messages are deleted only in private chats", async () => {
  const deleted: number[] = [];
  await deleteIncoming(fakeCtx(deleted));
  await deleteIncoming(fakeCtx(deleted, "group"));
  assert.deepEqual(deleted, [999]);
});
