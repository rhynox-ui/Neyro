import { neon } from "@neondatabase/serverless";
import { config } from "../config.js";
import { UserFacingError } from "../errors.js";

export type Side = "buy" | "sell";
export type SlippagePrefs = Record<Side, number>;

export const DEFAULT_SLIPPAGE_PCT = 5;
export const MIN_SLIPPAGE_PCT = 0.1;
/** Matches DEFAULT_RISK_POLICY.maxSlippageBps. */
export const MAX_SLIPPAGE_PCT = 15;

export interface SettingsRepository {
  load(telegramUserId: number): Promise<Partial<SlippagePrefs> | null>;
  save(telegramUserId: number, side: Side, value: number): Promise<void>;
}

export class InMemorySettingsRepository implements SettingsRepository {
  private readonly rows = new Map<number, Partial<SlippagePrefs>>();
  async load(id: number) { return this.rows.get(id) ?? null; }
  async save(id: number, side: Side, value: number) { this.rows.set(id, { ...this.rows.get(id), [side]: value }); }
}

export class PostgresSettingsRepository implements SettingsRepository {
  private readonly sql: ReturnType<typeof neon>;
  constructor(databaseUrl: string) { this.sql = neon(databaseUrl); }

  async load(id: number): Promise<Partial<SlippagePrefs> | null> {
    const rows = (await this.sql`select buy_slippage_pct, sell_slippage_pct from users
      where telegram_user_id=${id} limit 1`) as unknown as { buy_slippage_pct: string | null; sell_slippage_pct: string | null }[];
    const row = rows[0];
    if (!row) return null;
    return {
      ...(row.buy_slippage_pct !== null ? { buy: Number(row.buy_slippage_pct) } : {}),
      ...(row.sell_slippage_pct !== null ? { sell: Number(row.sell_slippage_pct) } : {})
    };
  }

  async save(id: number, side: Side, value: number): Promise<void> {
    if (side === "buy") {
      await this.sql`insert into users (telegram_user_id, buy_slippage_pct) values (${id}, ${value})
        on conflict (telegram_user_id) do update set buy_slippage_pct=excluded.buy_slippage_pct`;
    } else {
      await this.sql`insert into users (telegram_user_id, sell_slippage_pct) values (${id}, ${value})
        on conflict (telegram_user_id) do update set sell_slippage_pct=excluded.sell_slippage_pct`;
    }
  }
}

export function assertSlippagePct(value: number): number {
  if (!Number.isFinite(value) || value < MIN_SLIPPAGE_PCT || value > MAX_SLIPPAGE_PCT) {
    throw new UserFacingError(`Slippage must be between ${MIN_SLIPPAGE_PCT}% and ${MAX_SLIPPAGE_PCT}%`);
  }
  return Math.round(value * 10) / 10;
}

/** Per-user default slippage for buys and sells, cached in memory. */
export class SettingsService {
  private readonly cache = new Map<number, SlippagePrefs>();

  constructor(
    private readonly repository: SettingsRepository = config.DATABASE_URL
      ? new PostgresSettingsRepository(config.DATABASE_URL)
      : new InMemorySettingsRepository()
  ) {}

  async slippage(userId: number): Promise<SlippagePrefs> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const stored = await this.repository.load(userId).catch((error) => {
      console.warn("Could not load settings", error);
      return null;
    });
    const prefs = { buy: stored?.buy ?? DEFAULT_SLIPPAGE_PCT, sell: stored?.sell ?? DEFAULT_SLIPPAGE_PCT };
    this.cache.set(userId, prefs);
    return prefs;
  }

  async setSlippage(userId: number, side: Side, value: number): Promise<number> {
    const rounded = assertSlippagePct(value);
    const prefs = { ...(await this.slippage(userId)), [side]: rounded };
    this.cache.set(userId, prefs);
    await this.repository.save(userId, side, rounded);
    return rounded;
  }
}
