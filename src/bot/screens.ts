import type { Context } from "grammy";
import { defaultStateStore, type StateStore } from "../state/store.js";
import { scheduleDeletion } from "./autodelete.js";

/**
 * Keeps the chat tidy. Menus and views ("screens": token panel, wallet,
 * settings, portfolio, ...) are replaced: showing a new one deletes the
 * previous screen of the same kind. Results the user may need later (trade
 * receipts, withdrawals, the exported key) are never tracked, so they stay.
 */
export type ScreenKind = "menu" | "panel" | "wallet" | "deposit" | "balance" | "portfolio" | "settings" | "feed" | "withdraw" | "launch";

type Screen = { chatId: number; messageId: number };

const SCREEN_TTL_MS = 2 * 24 * 60 * 60 * 1000; // Telegram allows deleting bot messages for 48h
const NOTICE_TTL_MS = 60_000;

const key = (kind: ScreenKind) => `screen:${kind}`;

/** Records `messageId` as the current screen of `kind`, deleting the previous one. */
export async function trackScreen(
  ctx: Context,
  kind: ScreenKind,
  chatId: number,
  messageId: number,
  store: StateStore = defaultStateStore()
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const previous = await store.get<Screen>(userId, key(kind)).catch(() => null);
  if (previous && previous.messageId !== messageId) {
    await ctx.api.deleteMessage(previous.chatId, previous.messageId).catch(() => {});
  }
  await store.set(userId, key(kind), { chatId, messageId } satisfies Screen, SCREEN_TTL_MS).catch(() => {});
}

/** Stops tracking a screen so it is kept, e.g. once it has become a receipt. */
export async function keepScreen(ctx: Context, kind: ScreenKind, store: StateStore = defaultStateStore()): Promise<void> {
  const userId = ctx.from?.id;
  if (userId) await store.delete(userId, key(kind)).catch(() => {});
}

/** Sends a new screen and replaces the previous one of the same kind. */
export async function replyScreen(
  ctx: Context,
  kind: ScreenKind,
  text: string,
  options?: Parameters<Context["reply"]>[1]
): Promise<void> {
  const sent = await ctx.reply(text, options);
  await trackScreen(ctx, kind, sent.chat.id, sent.message_id);
}

/** Deletes the user's own message (bots may do this in private chats). */
export async function deleteIncoming(ctx: Context): Promise<void> {
  if (ctx.chat?.type === "private" && ctx.message) await ctx.deleteMessage().catch(() => {});
}

/** A short-lived message, removed by the per-minute sweep after about a minute. */
export async function replyNotice(ctx: Context, text: string, options?: Parameters<Context["reply"]>[1]): Promise<void> {
  const sent = await ctx.reply(text, options);
  if (ctx.from) await scheduleDeletion(ctx.from.id, sent.chat.id, sent.message_id, NOTICE_TTL_MS).catch(() => {});
}
