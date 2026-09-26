import { neon } from "@neondatabase/serverless";
import { config } from "../config.js";

/**
 * Short-lived per-user state (open token panel, pending withdrawal).
 *
 * On Cloudflare Workers each Telegram update may run in a different isolate,
 * so this cannot live in process memory there; Postgres is the default
 * whenever DATABASE_URL is set. Values must be JSON-serializable.
 */
export interface StateStore {
  get<T>(userId: number, key: string): Promise<T | null>;
  set(userId: number, key: string, value: unknown, ttlMs: number): Promise<void>;
  delete(userId: number, key: string): Promise<void>;
  /** Atomically reads and deletes, so a value can be consumed only once. */
  take<T>(userId: number, key: string): Promise<T | null>;
  /**
   * Removes and returns entries under `prefix` whose value has `dueAtMs` in
   * the past (used for scheduled work such as deleting messages).
   */
  takeDue<T extends { dueAtMs: number }>(prefix: string, nowMs: number): Promise<{ userId: number; value: T }[]>;
}

export class InMemoryStateStore implements StateStore {
  private readonly rows = new Map<string, { value: string; expiresAt: number }>();
  private id(userId: number, key: string) { return `${userId}:${key}`; }

  async get<T>(userId: number, key: string): Promise<T | null> {
    const row = this.rows.get(this.id(userId, key));
    if (!row || row.expiresAt <= Date.now()) return null;
    return JSON.parse(row.value) as T;
  }
  async set(userId: number, key: string, value: unknown, ttlMs: number): Promise<void> {
    this.rows.set(this.id(userId, key), { value: JSON.stringify(value), expiresAt: Date.now() + ttlMs });
  }
  async delete(userId: number, key: string): Promise<void> {
    this.rows.delete(this.id(userId, key));
  }
  async take<T>(userId: number, key: string): Promise<T | null> {
    const value = await this.get<T>(userId, key);
    this.rows.delete(this.id(userId, key));
    return value;
  }
  async takeDue<T extends { dueAtMs: number }>(prefix: string, nowMs: number) {
    const due: { userId: number; value: T }[] = [];
    for (const [id, row] of this.rows) {
      const [userId, ...rest] = id.split(":");
      if (!rest.join(":").startsWith(prefix)) continue;
      const value = JSON.parse(row.value) as T;
      if (value.dueAtMs <= nowMs) {
        this.rows.delete(id);
        due.push({ userId: Number(userId), value });
      }
    }
    return due;
  }
}

export class PostgresStateStore implements StateStore {
  private readonly sql: ReturnType<typeof neon>;
  constructor(databaseUrl: string) { this.sql = neon(databaseUrl); }

  async get<T>(userId: number, key: string): Promise<T | null> {
    const rows = (await this.sql`select value from bot_state
      where telegram_user_id=${userId} and key=${key} and expires_at > now()`) as unknown as { value: T }[];
    return rows[0]?.value ?? null;
  }
  async set(userId: number, key: string, value: unknown, ttlMs: number): Promise<void> {
    await this.sql`insert into bot_state (telegram_user_id, key, value, expires_at)
      values (${userId}, ${key}, ${JSON.stringify(value)}::jsonb, now() + (${ttlMs} * interval '1 millisecond'))
      on conflict (telegram_user_id, key) do update set value=excluded.value, expires_at=excluded.expires_at`;
  }
  async delete(userId: number, key: string): Promise<void> {
    await this.sql`delete from bot_state where telegram_user_id=${userId} and key=${key}`;
  }
  async takeDue<T extends { dueAtMs: number }>(prefix: string, nowMs: number) {
    const rows = (await this.sql`delete from bot_state
      where key like ${prefix + "%"} and (value->>'dueAtMs')::bigint <= ${nowMs}
      returning telegram_user_id, value`) as unknown as { telegram_user_id: string | number; value: T }[];
    return rows.map((row) => ({ userId: Number(row.telegram_user_id), value: row.value }));
  }

  async take<T>(userId: number, key: string): Promise<T | null> {
    const rows = (await this.sql`delete from bot_state
      where telegram_user_id=${userId} and key=${key}
      returning value, expires_at > now() as live`) as unknown as { value: T; live: boolean }[];
    return rows[0]?.live ? rows[0].value : null;
  }
}

let shared: StateStore | undefined;

export function defaultStateStore(): StateStore {
  shared ??= config.DATABASE_URL ? new PostgresStateStore(config.DATABASE_URL) : new InMemoryStateStore();
  return shared;
}
