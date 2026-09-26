import { neon } from "@neondatabase/serverless";
import type { EncryptedSecret } from "../security/secrets.js";

export type StoredWallet={telegramUserId:number;accountId:string;encryptedKey:EncryptedSecret};
export interface WalletRepository{getByTelegramUserId(id:number):Promise<StoredWallet|null>;save(wallet:StoredWallet):Promise<void>}

export class InMemoryWalletRepository implements WalletRepository{
 private readonly wallets=new Map<number,StoredWallet>();
 async getByTelegramUserId(id:number){return this.wallets.get(id)??null}
 async save(wallet:StoredWallet){this.wallets.set(wallet.telegramUserId,wallet)}
}

type WalletRow={telegram_user_id:number|string;near_account_id:string;cipher_version:number;iv_base64:string;auth_tag_base64:string;ciphertext_base64:string};

export class PostgresWalletRepository implements WalletRepository{
 private readonly sql:ReturnType<typeof neon>;
 constructor(databaseUrl:string){this.sql=neon(databaseUrl)}
 async getByTelegramUserId(id:number):Promise<StoredWallet|null>{
  const rows=(await this.sql`select u.telegram_user_id,w.near_account_id,ws.cipher_version,ws.iv_base64,ws.auth_tag_base64,ws.ciphertext_base64 from users u join wallets w on w.user_id=u.id join wallet_secrets ws on ws.wallet_id=w.id where u.telegram_user_id=${id} limit 1`) as unknown as WalletRow[];
  const row=rows[0] as WalletRow|undefined; if(!row)return null;
  return {telegramUserId:Number(row.telegram_user_id),accountId:row.near_account_id,encryptedKey:{version:row.cipher_version as 1|2,iv:row.iv_base64,tag:row.auth_tag_base64,ciphertext:row.ciphertext_base64}};
 }
 // One statement, so the user, wallet and secret rows are written atomically.
 // If the user already has a wallet (or the account exists), nothing is written.
 async save(wallet:StoredWallet):Promise<void>{
  await this.sql`with u as (
    insert into users(telegram_user_id) values(${wallet.telegramUserId})
    on conflict(telegram_user_id) do update set telegram_user_id=excluded.telegram_user_id
    returning id
   ), w as (
    insert into wallets(user_id,near_account_id,signer_ref)
    select id,${wallet.accountId},${"near:"+wallet.accountId} from u
    on conflict do nothing
    returning id
   )
   insert into wallet_secrets(wallet_id,cipher_version,iv_base64,auth_tag_base64,ciphertext_base64)
   select id,${wallet.encryptedKey.version},${wallet.encryptedKey.iv},${wallet.encryptedKey.tag},${wallet.encryptedKey.ciphertext} from w`;
 }
}