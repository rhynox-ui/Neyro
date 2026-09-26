import { neon } from "@neondatabase/serverless";

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

export interface TradeRepository {
  create(record: TradeRecord): Promise<void>;
  updateStatus(userId: number, idempotencyKey: string, update: TradeStatusUpdate): Promise<void>;
  recordEvent(userId: number, idempotencyKey: string, event: TradeEvent): Promise<void>;
}

export class NoopTradeRepository implements TradeRepository {
  async create(_record: TradeRecord): Promise<void> {}
  async updateStatus(_userId: number, _idempotencyKey: string, _update: TradeStatusUpdate): Promise<void> {}
  async recordEvent(_userId: number, _idempotencyKey: string, _event: TradeEvent): Promise<void> {}
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
      slippage_bps,idempotency_key,router,tx_hash,status,error_code
    ) values (
      ${userId},${walletId},${record.side},${record.tokenIn},${record.tokenOut},
      ${record.amountIn},${record.expectedOut},${record.slippageBps},
      ${record.idempotencyKey},${record.router ?? null},${record.txHash ?? null},
      ${record.status},${record.errorCode ?? null}
    ) on conflict (user_id,idempotency_key) do nothing`;
  }

  async updateStatus(userId: number, idempotencyKey: string, update: TradeStatusUpdate): Promise<void> {
    await this.sql`update trades t set status=${update.status},
      tx_hash=coalesce(${update.txHash ?? null},t.tx_hash),
      actual_out=coalesce(${update.actualOut ?? null},t.actual_out),
      error_code=${update.errorCode ?? null}, updated_at=now()
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
}
