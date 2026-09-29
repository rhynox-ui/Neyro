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
  status: "quoted" | "executing" | "submitted" | "failed" | "expired" | "cancelled";
  txHash?: string;
  errorCode?: string;
};

export interface TradeRepository {
  create(record: TradeRecord): Promise<void>;
  updateStatus(userId: number, idempotencyKey: string, status: TradeRecord["status"], txHash?: string, errorCode?: string): Promise<void>;
  listInFlight(): Promise<TradeRecord[]>;
}

export class NoopTradeRepository implements TradeRepository {
  async create(_record: TradeRecord): Promise<void> {}
  async updateStatus(_userId: number, _idempotencyKey: string, _status: TradeRecord["status"], _txHash?: string, _errorCode?: string): Promise<void> {}
  async listInFlight(): Promise<TradeRecord[]> { return []; }
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

  async updateStatus(userId:number,idempotencyKey:string,status:TradeRecord["status"],txHash?:string,errorCode?:string):Promise<void>{
    await this.sql`update trades t set status=${status}, tx_hash=coalesce(${txHash ?? null},t.tx_hash),
      error_code=${errorCode ?? null}, updated_at=now()
      from users u where t.user_id=u.id and u.telegram_user_id=${userId}
      and t.idempotency_key=${idempotencyKey}`;
  }

  async listInFlight(): Promise<TradeRecord[]> {
    const rows = await this.sql`
      select
        u.telegram_user_id as user_id,
        w.near_account_id as account_id,
        t.side,
        t.token_in,
        t.token_out,
        t.amount_in,
        t.expected_out,
        t.slippage_bps,
        t.router,
        t.idempotency_key,
        t.status,
        t.tx_hash,
        t.error_code
      from trades t
      join users u on u.id=t.user_id
      join wallets w on w.id=t.wallet_id
      where t.status in ('executing', 'submitted')
      order by t.updated_at asc
      limit 100
    ` as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      userId: Number(row.user_id),
      accountId: String(row.account_id),
      side: row.side as TradeRecord["side"],
      tokenIn: String(row.token_in),
      tokenOut: String(row.token_out),
      amountIn: String(row.amount_in),
      expectedOut: String(row.expected_out),
      slippageBps: Number(row.slippage_bps),
      router: row.router ? String(row.router) : undefined,
      idempotencyKey: String(row.idempotency_key),
      status: row.status as TradeRecord["status"],
      txHash: row.tx_hash ? String(row.tx_hash) : undefined,
      errorCode: row.error_code ? String(row.error_code) : undefined
    }));
  }
}