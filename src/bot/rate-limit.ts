import type { Context, NextFunction } from "grammy";

/**
 * Sliding-window limit per Telegram user. On Cloudflare Workers the window
 * is per isolate, which still stops a single user flooding one instance
 * (every quote costs RHEA and RPC calls).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now = () => Date.now()) {}

  /** Records a hit; false when the key is over its limit. */
  take(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
    }
  }
}

// Any update: generous, stops floods. Quotes: tighter, they hit external APIs.
const updates = new RateLimiter(40, 60_000);
const quotes = new RateLimiter(12, 60_000);

const QUOTE_CALLBACK = /^tp:exec$/;
const QUOTE_COMMAND = /^\/(buy|sell)(@\w+)?\s+\S+\s+\S+/;

export async function rateLimit(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return next();

  if (!updates.take(`u:${userId}`)) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery("Slow down a little.").catch(() => {});
    return;
  }

  const isQuote = QUOTE_CALLBACK.test(ctx.callbackQuery?.data ?? "") || QUOTE_COMMAND.test(ctx.message?.text ?? "");
  if (isQuote && !quotes.take(`q:${userId}`)) {
    const message = "Too many quotes in a minute. Please wait a moment.";
    if (ctx.callbackQuery) await ctx.answerCallbackQuery(message).catch(() => {});
    else await ctx.reply(message).catch(() => {});
    return;
  }

  return next();
}
