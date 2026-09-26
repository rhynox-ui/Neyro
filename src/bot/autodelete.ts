import type { Api } from "grammy";
import { defaultStateStore, type StateStore } from "../state/store.js";

const PREFIX = "autodelete:";

type Scheduled = { chatId: number; messageId: number; dueAtMs: number };

/** Deletes a message after `delayMs`, via the per-minute sweep (works on Workers). */
export async function scheduleDeletion(
  userId: number,
  chatId: number,
  messageId: number,
  delayMs: number,
  store: StateStore = defaultStateStore()
): Promise<void> {
  const value: Scheduled = { chatId, messageId, dueAtMs: Date.now() + delayMs };
  await store.set(userId, `${PREFIX}${chatId}:${messageId}`, value, 24 * 60 * 60 * 1000);
}

/** Deletes every message whose time has come. Safe to run from several instances. */
export async function deleteDueMessages(api: Api, store: StateStore = defaultStateStore(), nowMs = Date.now()): Promise<number> {
  const due = await store.takeDue<Scheduled>(PREFIX, nowMs);
  await Promise.all(due.map(({ value }) =>
    api.deleteMessage(value.chatId, value.messageId).catch(() => {
      // Already deleted by the user, or older than Telegram's 48h limit.
    })
  ));
  return due.length;
}
