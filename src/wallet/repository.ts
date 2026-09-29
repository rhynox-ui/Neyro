import { neon } from "@neondatabase/serverless";
import type { EncryptedSecret } from "../security/secrets.js";

export type StoredWallet = { telegramUserId: number; accountId: string; encryptedKey: EncryptedSecret };

export type WalletSummary = { accountId: string; active: boolean };

/**
 * A user can hold several wallets; one is active. Everything that doesn't
 * name an account (balance, portfolio, new quotes) uses the active wallet.
 */
export interface WalletRepository {
  /** The active wallet, or the user's first wallet if none is marked active. */
  getByTelegramUserId(id: number): Promise<StoredWallet | null>;
  /** A specific wallet, only if it belongs to this user. */
  getByAccount(id: number, accountId: string): Promise<StoredWallet | null>;
  /** All of the user's wallets, oldest first. */
  list(id: number): Promise<WalletSummary[]>;
  /** Stores a new wallet and makes it active. */
  save(wallet: StoredWallet): Promise<void>;
  /** Returns false if the account isn't one of this user's wallets. */
  setActive(id: number, accountId: string): Promise<boolean>;
}

export class InMemoryWalletRepository implements WalletRepository {
  private readonly wallets = new Map<number, StoredWallet[]>();
  private readonly active = new Map<number, string>();

  async getByTelegramUserId(id: number) {
    const wallets = this.wallets.get(id) ?? [];
    return wallets.find((wallet) => wallet.accountId === this.active.get(id)) ?? wallets[0] ?? null;
  }
  async getByAccount(id: number, accountId: string) {
    return (this.wallets.get(id) ?? []).find((wallet) => wallet.accountId === accountId) ?? null;
  }
  async list(id: number) {
    const current = (await this.getByTelegramUserId(id))?.accountId;
    return (this.wallets.get(id) ?? []).map((wallet) => ({ accountId: wallet.accountId, active: wallet.accountId === current }));
  }
  async save(wallet: StoredWallet) {
    this.wallets.set(wallet.telegramUserId, [...(this.wallets.get(wallet.telegramUserId) ?? []), wallet]);
    this.active.set(wallet.telegramUserId, wallet.accountId);
  }
  async setActive(id: number, accountId: string) {
    if (!(await this.getByAccount(id, accountId))) return false;
    this.active.set(id, accountId);
    return true;
  }
}

type WalletRow = {
  telegram_user_id: number | string;
  near_account_id: string;
  cipher_version: number;
  iv_base64: string;
  auth_tag_base64: string;
  ciphertext_base64: string;
};

function toStored(row: WalletRow): StoredWallet {
  return {
    telegramUserId: Number(row.telegram_user_id),
    accountId: row.near_account_id,
    encryptedKey: { version: row.cipher_version as 1 | 2, iv: row.iv_base64, tag: row.auth_tag_base64, ciphertext: row.ciphertext_base64 }
  };
}

export class PostgresWalletRepository implements WalletRepository {
  private readonly sql: ReturnType<typeof neon>;
  constructor(databaseUrl: string) { this.sql = neon(databaseUrl); }

  async getByTelegramUserId(id: number): Promise<StoredWallet | null> {
    const rows = (await this.sql`select u.telegram_user_id, w.near_account_id, ws.cipher_version,
        ws.iv_base64, ws.auth_tag_base64, ws.ciphertext_base64
      from users u
      join wallets w on w.user_id = u.id
      join wallet_secrets ws on ws.wallet_id = w.id
      where u.telegram_user_id = ${id}
      order by (w.id = u.active_wallet_id) is true desc, w.created_at asc
      limit 1`) as unknown as WalletRow[];
    return rows[0] ? toStored(rows[0]) : null;
  }

  async getByAccount(id: number, accountId: string): Promise<StoredWallet | null> {
    const rows = (await this.sql`select u.telegram_user_id, w.near_account_id, ws.cipher_version,
        ws.iv_base64, ws.auth_tag_base64, ws.ciphertext_base64
      from users u
      join wallets w on w.user_id = u.id
      join wallet_secrets ws on ws.wallet_id = w.id
      where u.telegram_user_id = ${id} and w.near_account_id = ${accountId}
      limit 1`) as unknown as WalletRow[];
    return rows[0] ? toStored(rows[0]) : null;
  }

  async list(id: number): Promise<WalletSummary[]> {
    const rows = (await this.sql`select w.near_account_id, w.id = u.active_wallet_id as active
      from users u join wallets w on w.user_id = u.id
      join wallet_secrets ws on ws.wallet_id = w.id
      where u.telegram_user_id = ${id}
      order by w.created_at asc`) as unknown as { near_account_id: string; active: boolean | null }[];
    // With no active wallet stored yet, the oldest one is active.
    const anyActive = rows.some((row) => row.active);
    return rows.map((row, index) => ({ accountId: row.near_account_id, active: anyActive ? Boolean(row.active) : index === 0 }));
  }

  // One statement, so the user, wallet, secret and active pointer are written
  // atomically. The users row is modified at most once: Postgres doesn't
  // support changing the same row twice in one statement. A brand-new user
  // row isn't visible to the final update, which is fine: with no active
  // pointer, the only (oldest) wallet is the active one.
  async save(wallet: StoredWallet): Promise<void> {
    await this.sql`with inserted as (
        insert into users (telegram_user_id) values (${wallet.telegramUserId})
        on conflict (telegram_user_id) do nothing
        returning id
      ), u as (
        select id from inserted
        union all
        select id from users where telegram_user_id = ${wallet.telegramUserId}
        limit 1
      ), w as (
        insert into wallets (user_id, near_account_id, signer_ref)
        select id, ${wallet.accountId}, ${"near:" + wallet.accountId} from u
        on conflict do nothing
        returning id, user_id
      ), s as (
        insert into wallet_secrets (wallet_id, cipher_version, iv_base64, auth_tag_base64, ciphertext_base64)
        select id, ${wallet.encryptedKey.version}, ${wallet.encryptedKey.iv}, ${wallet.encryptedKey.tag}, ${wallet.encryptedKey.ciphertext}
        from w
        returning wallet_id
      )
      update users set active_wallet_id = w.id from w where users.id = w.user_id`;
  }

  async setActive(id: number, accountId: string): Promise<boolean> {
    const rows = (await this.sql`update users u set active_wallet_id = w.id
      from wallets w
      where w.user_id = u.id and u.telegram_user_id = ${id} and w.near_account_id = ${accountId}
      returning u.id`) as unknown as { id: string }[];
    return rows.length > 0;
  }
}
