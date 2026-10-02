import { neon } from "@neondatabase/serverless";
import type { TradeQuote, TradeRequest } from "../domain/trading.js";
import type { FeePlan } from "./fee.js";

/** Everything needed to execute a confirmed quote; stored as JSON. */
export type PendingPayload = {
  request: TradeRequest;
  quote: TradeQuote;
  fee?: FeePlan;
  /** Original user-entered amount before any NEARly sell tax adjustment. */
  feeBaseAmount?: string;
};

export type ClaimResult =
  /** The trade moved from quoted to executing; only one caller can get this. */
  | { kind: "claimed"; payload: PendingPayload }
  /** Unknown, expired, cancelled, or already claimed. */
  | { kind: "unavailable" }
  /** This repository does not persist trades; the caller uses its own state. */
  | { kind: "untracked" };

export type TradeRecord = {
  userId: number;
  accountId: string;
  side: "buy" | "sell";
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedOut: string;
  slippageBps: number;
  router?: string;
  idempotencyKey: string;
  status: TradeStatus;
  txHash?: string;
  errorCode?: string;
  expiresAt?: Date;
  payload?: PendingPayload;
  /** Protocol fee in base units of feeAsset. */
  feeAmount?: string;
  feeAsset?: string;
};

/**
 * - submitted: every transaction executed but the fill could not be verified
 * - filled: executed and the token balance moved as expected
 * - reverted: executed on chain, but the swap failed or was refunded
 * - partial: part of a multi-transaction batch executed, the rest was rejected
 * - unknown: broadcast was attempted and the outcome is not yet known; never retry
 * - failed: nothing reached the chain; safe to retry
 */
export type TradeStatus =
  | "quoted" | "executing" | "submitted" | "filled" | "reverted"
  | "partial" | "unknown" | "failed" | "expired" | "cancelled";

export type TradeStatusUpdate = {
  status: TradeStatus;
  txHash?: string;
  actualOut?: string;
  errorCode?: string;
};

export type TradeEvent = {
  type: string;
  txHash?: string;
  details?: Record<string, unknown>;
};

/** A trade whose on-chain outcome still has to be established. */
export type UnresolvedFee = {
  telegramUserId: number;
  idempotencyKey: string;
  accountId: string;
  txHash: string;
  details: Record<string, unknown>;
  createdAt: Date;
};

export type UnresolvedTrade = {
  telegramUserId: number;
  idempotencyKey: string;
  accountId: string;
  status: "unknown" | "executing";
  updatedAt: Date;
  /** Journaled before broadcast, in order. */
  txHashes: string[];
};

export interface TradeRepository {
  /** Trades left unknown, or executing for longer than `staleMs` (e.g. after a crash). */
  listUnresolved(staleMs: number, limit: number): Promise<UnresolvedTrade[]>;
  listUnresolvedFees(limit: number): Promise<UnresolvedFee[]>;
  recordFeeResolution(userId: number, idempotencyKey: string, txHash: string, status: "collected" | "failed"): Promise<boolean>;
  /**
   * Moves an unresolved trade to its final status. Returns false if another
   * worker already resolved it.
   */
  resolve(userId: number, idempotencyKey: string, update: TradeStatusUpdate): Promise<boolean>;
  create(record: TradeRecord): Promise<void>;
  /** Atomically moves a live quote to executing and returns its payload. */
  claim(userId: number, idempotencyKey: string): Promise<ClaimResult>;
  /** Cancels a quote that has not been claimed yet. */
  cancel(userId: number, idempotencyKey: string): Promise<void>;
  updateStatus(userId: number, idempotencyKey: string, update: TradeStatusUpdate): Promise<void>;
  recordEvent(userId: number, idempotencyKey: string, event: TradeEvent): Promise<void>;
}

export class NoopTradeRepository implements TradeRepository {
  async create(_record: TradeRecord): Promise<void> {}
  async claim(_userId: number, _idempotencyKey: string): Promise<ClaimResult> { return { kind: "untracked" }; }
  async cancel(_userId: number, _idempotencyKey: string): Promise<void> {}
  async updateStatus(_userId: number, _idempotencyKey: string, _update: TradeStatusUpdate): Promise<void> {}
  async recordEvent(_userId: number, _idempotencyKey: string, _event: TradeEvent): Promise<void> {}
  async listUnresolved(_staleMs: number, _limit: number): Promise<UnresolvedTrade[]> { return []; }
  async listUnresolvedFees(_limit: number): Promise<UnresolvedFee[]> { return []; }
  async recordFeeResolution(_userId: number, _idempotencyKey: string, _txHash: string, _status: "collected" | "failed"): Promise<boolean> { return false; }
  async resolve(_userId: number, _idempotencyKey: string, _update: TradeStatusUpdate): Promise<boolean> { return false; }
}

export class PostgresTradeRepository implements TradeRepository {
  private readonly sql: ReturnType<typeof neon>;
  constructor(databaseUrl: string) { this.sql = neon(databaseUrl); }

  async create(record: TradeRecord): Promise<void> {
    await this.sql`insert into users (telegram_user_id)
      values (${record.userId}) on conflict (telegram_user_id) do nothing`;

    const users = (await this.sql`select id from users where telegram_user_id=${record.userId} limit 1`) as unknown as { id: string }[];
    const userId = users[0]?.id;
    if (!userId) throw new Error("Trade user record was not found");

    const wallets = (await this.sql`select id from wallets where user_id=${userId} and near_account_id=${record.accountId} limit 1`) as unknown as { id: string }[];
    const walletId = wallets[0]?.id;
    if (!walletId) throw new Error("Trade wallet record was not found");

    await this.sql`insert into trades (
      user_id,wallet_id,side,token_in,token_out,amount_in,expected_out,
      slippage_bps,idempotency_key,router,tx_hash,status,error_code,
      quote_expires_at,pending_payload,fee_amount,fee_asset
    ) values (
      ${userId},${walletId},${record.side},${record.tokenIn},${record.tokenOut},
      ${record.amountIn},${record.expectedOut},${record.slippageBps},
      ${record.idempotencyKey},${record.router ?? null},${record.txHash ?? null},
      ${record.status},${record.errorCode ?? null},
      ${record.expiresAt?.toISOString() ?? null},
      ${record.payload ? JSON.stringify(record.payload) : null}::jsonb,
      ${record.feeAmount ?? null},${record.feeAsset ?? null}
    ) on conflict (user_id,idempotency_key) do nothing`;
  }

  async claim(userId: number, idempotencyKey: string): Promise<ClaimResult> {
    const rows = (await this.sql`update trades t set status='executing', updated_at=now()
      from users u where t.user_id=u.id and u.telegram_user_id=${userId}
      and t.idempotency_key=${idempotencyKey} and t.status='quoted'
      and t.quote_expires_at > now() and t.pending_payload is not null
      returning t.pending_payload`) as unknown as { pending_payload: PendingPayload }[];
    const payload = rows[0]?.pending_payload;
    return payload ? { kind: "claimed", payload } : { kind: "unavailable" };
  }

  async cancel(userId: number, idempotencyKey: string): Promise<void> {
    await this.sql`update trades t set status='cancelled', pending_payload=null, updated_at=now()
      from users u where t.user_id=u.id and u.telegram_user_id=${userId}
      and t.idempotency_key=${idempotencyKey} and t.status='quoted'`;
  }

  async updateStatus(userId: number, idempotencyKey: string, update: TradeStatusUpdate): Promise<void> {
    await this.sql`update trades t set status=${update.status},
      tx_hash=coalesce(${update.txHash ?? null},t.tx_hash),
      actual_out=coalesce(${update.actualOut ?? null},t.actual_out),
      error_code=${update.errorCode ?? null},
      pending_payload=case when ${update.status} in ('quoted','executing') then t.pending_payload else null end,
      updated_at=now()
      from users u where t.user_id=u.id and u.telegram_user_id=${userId}
      and t.idempotency_key=${idempotencyKey}`;
  }

  async recordEvent(userId: number, idempotencyKey: string, event: TradeEvent): Promise<void> {
    const rows = (await this.sql`insert into trade_events (trade_id,event_type,tx_hash,details)
      select t.id, ${event.type}, ${event.txHash ?? null}, ${JSON.stringify(event.details ?? {})}::jsonb
      from trades t join users u on t.user_id=u.id
      where u.telegram_user_id=${userId} and t.idempotency_key=${idempotencyKey}
      returning id`) as unknown as { id: string }[];
    if (rows.length === 0) throw new Error("Trade event could not be recorded");
  }

  async listUnresolvedFees(limit: number): Promise<UnresolvedFee[]> {
    const rows = (await this.sql`
      select u.telegram_user_id, t.idempotency_key, w.near_account_id,
        e.tx_hash, e.details, e.created_at
      from trade_events e
      join trades t on t.id=e.trade_id
      join users u on u.id=t.user_id
      join wallets w on w.id=t.wallet_id
      where e.event_type='fee_uncollected' and e.tx_hash is not null
        and not exists (
          select 1 from trade_events done
          where done.trade_id=e.trade_id
            and done.event_type='fee_collected'
            and done.tx_hash=e.tx_hash
        )
      order by e.created_at
      limit ${limit}
    `) as unknown as {
      telegram_user_id: string | number; idempotency_key: string; near_account_id: string;
      tx_hash: string; details: Record<string, unknown>; created_at: string | Date;
    }[];
    return rows.map((row) => ({
      telegramUserId: Number(row.telegram_user_id),
      idempotencyKey: row.idempotency_key,
      accountId: row.near_account_id,
      txHash: row.tx_hash,
      details: row.details ?? {},
      createdAt: new Date(row.created_at)
    }));
  }

  async recordFeeResolution(userId: number, idempotencyKey: string, txHash: string, status: "collected" | "failed"): Promise<boolean> {
    const rows = (await this.sql`
      insert into trade_events (trade_id,event_type,tx_hash,details)
      select t.id, ${status === "collected" ? "fee_collected" : "fee_failed"}, ${txHash}, ${JSON.stringify({ reconciled: true })}::jsonb
      from trades t join users u on u.id=t.user_id
      where u.telegram_user_id=${userId} and t.idempotency_key=${idempotencyKey}
        and not exists (
          select 1 from trade_events done
          where done.trade_id=t.id
            and done.event_type in ('fee_collected','fee_failed')
            and done.tx_hash=${txHash}
        )
      returning id
    `) as unknown as { id: string }[];
    return rows.length > 0;
  }

  async listUnresolved(staleMs: number, limit: number): Promise<UnresolvedTrade[]> {
    const rows = (await this.sql`select u.telegram_user_id, t.idempotency_key, w.near_account_id,
        t.status, t.updated_at,
        coalesce(array_agg(e.tx_hash order by e.created_at) filter (where e.tx_hash is not null), '{}') as tx_hashes
      from trades t
      join users u on u.id=t.user_id
      join wallets w on w.id=t.wallet_id
      left join trade_events e on e.trade_id=t.id and e.event_type='tx_signed'
      where t.status='unknown'
        or (t.status='executing' and t.updated_at < now() - (${staleMs} * interval '1 millisecond'))
      group by u.telegram_user_id, t.idempotency_key, w.near_account_id, t.status, t.updated_at
      order by t.updated_at
      limit ${limit}`) as unknown as {
        telegram_user_id: string | number; idempotency_key: string; near_account_id: string;
        status: "unknown" | "executing"; updated_at: string | Date; tx_hashes: string[];
      }[];
    return rows.map((row) => ({
      telegramUserId: Number(row.telegram_user_id),
      idempotencyKey: row.idempotency_key,
      accountId: row.near_account_id,
      status: row.status,
      updatedAt: new Date(row.updated_at),
      txHashes: row.tx_hashes
    }));
  }

  async resolve(userId: number, idempotencyKey: string, update: TradeStatusUpdate): Promise<boolean> {
    const rows = (await this.sql`update trades t set status=${update.status},
      tx_hash=coalesce(${update.txHash ?? null},t.tx_hash),
      error_code=${update.errorCode ?? null},
      pending_payload=null, updated_at=now()
      from users u where t.user_id=u.id and u.telegram_user_id=${userId}
      and t.idempotency_key=${idempotencyKey} and t.status in ('unknown','executing')
      returning t.id`) as unknown as { id: string }[];
    return rows.length > 0;
  }
}
