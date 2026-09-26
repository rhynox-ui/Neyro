-- Neyro PostgreSQL schema (initial production shape)

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  created_at timestamptz not null default now()
);

create table if not exists wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  near_account_id text not null unique,
  signer_ref text not null unique,
  created_at timestamptz not null default now()
);

-- MVP: one wallet per Telegram user; prevents concurrent /wallet from creating two.
create unique index if not exists wallets_user_id_key on wallets(user_id);

-- Encrypted key material only. The plaintext secret must never be stored.
-- Encryption keys belong in a deployment secret manager, not PostgreSQL.
create table if not exists wallet_secrets (
  wallet_id uuid primary key references wallets(id) on delete cascade,
  -- 1 = legacy AES-GCM without AAD; 2 = AAD bound to the wallet account id.
  cipher_version integer not null default 1,
  iv_base64 text not null,
  auth_tag_base64 text not null,
  ciphertext_base64 text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table if not exists tokens (
  id uuid primary key default gen_random_uuid(),
  chain text not null,
  address text not null,
  symbol text,
  decimals integer not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(chain, address)
);

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  wallet_id uuid not null references wallets(id),
  side text not null check (side in ('buy', 'sell')),
  token_in text not null,
  token_out text not null,
  amount_in numeric not null,
  expected_out numeric,
  actual_out numeric,
  slippage_bps integer not null,
  quote_expires_at timestamptz,
  idempotency_key text not null,
  router text,
  tx_hash text,
  status text not null,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, idempotency_key)
);

-- Quote + request JSON needed to execute a confirmation; cleared once the
-- trade leaves quoted/executing. Lets confirmations survive restarts and
-- makes the quoted → executing claim atomic across replicas.
alter table trades add column if not exists pending_payload jsonb;

-- Protocol fee charged on the trade, in base units of fee_asset (wrap.near
-- on buys, the sold token on sells).
alter table trades add column if not exists fee_amount numeric;
alter table trades add column if not exists fee_asset text;

create index if not exists trades_wallet_status_idx
  on trades(wallet_id, status, created_at desc);

create table if not exists positions (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references wallets(id) on delete cascade,
  token_id uuid not null references tokens(id),
  amount numeric not null default 0,
  average_entry numeric,
  updated_at timestamptz not null default now(),
  unique(wallet_id, token_id)
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete cascade,
  token_in text not null,
  token_out text not null,
  order_type text not null check (order_type in ('market', 'limit', 'take_profit', 'stop_loss')),
  amount numeric not null,
  trigger_price numeric,
  status text not null,
  created_at timestamptz not null default now()
);


-- Trade lifecycle events provide an append-only audit trail for execution attempts.
create table if not exists trade_events (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references trades(id) on delete cascade,
  event_type text not null,
  tx_hash text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists trade_events_trade_idx
  on trade_events(trade_id, created_at desc);
