import type { Api } from "grammy";
import { defaultStateStore, type StateStore } from "../state/store.js";

const DELETE_PREFIX = "autodelete:";
const REMIND_PREFIX = "autoremind:";
const DAY_MS = 24 * 60 * 60 * 1000;

type ScheduledDelete = { chatId: number; messageId: number; dueAtMs: number };
type ScheduledReminder = { chatId: number; replyTo: number; text: string; dueAtMs: number };

/**
 * Deletes a message after `delayMs` via the per-minute sweep (works on
 * Workers), optionally sending `reminder` (HTML) as a reply `remindBeforeMs`
 * earlier. Telegram only lets bots delete messages younger than 48 hours.
 */
export async function scheduleDeletion(
  userId: number,
  chatId: number,
  messageId: number,
  delayMs: number,
  store: StateStore = defaultStateStore(),
  reminder?: { text: string; remindBeforeMs: number }
): Promise<void> {
  const dueAtMs = Date.now() + delayMs;
  const deletion: ScheduledDelete = { chatId, messageId, dueAtMs };
  await store.set(userId, `${DELETE_PREFIX}${chatId}:${messageId}`, deletion, delayMs + DAY_MS);
  if (reminder && reminder.remindBeforeMs < delayMs) {
    const remind: ScheduledReminder = { chatId, replyTo: messageId, text: reminder.text, dueAtMs: dueAtMs - reminder.remindBeforeMs };
    await store.set(userId, `${REMIND_PREFIX}${chatId}:${messageId}`, remind, delayMs + DAY_MS);
  }
}

/**
 * Sends due reminders and deletes due messages. Entries are claimed
 * atomically, so running this from several instances acts once.
 */
export async function deleteDueMessages(api: Api, store: StateStore = defaultStateStore(), nowMs = Date.now()): Promise<number> {
  const reminders = await store.takeDue<ScheduledReminder>(REMIND_PREFIX, nowMs);
  await Promise.all(reminders.map(({ value }) =>
    api.sendMessage(value.chatId, value.text, {
      parse_mode: "HTML",
      reply_parameters: { message_id: value.replyTo, allow_sending_without_reply: true }
    }).catch(() => {})
  ));

  const due = await store.takeDue<ScheduledDelete>(DELETE_PREFIX, nowMs);
  await Promise.all(due.map(({ value }) =>
    api.deleteMessage(value.chatId, value.messageId).catch(() => {
      // Already deleted by the user, or older than Telegram's 48h limit.
    })
  ));
  return due.length;
}
