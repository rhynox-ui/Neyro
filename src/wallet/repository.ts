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
  const rows=await this.sql`select u.telegram_user_id,w.near_account_id,ws.cipher_version,ws.iv_base64,ws.auth_tag_base64,ws.ciphertext_base64 from users u join wallets w on w.user_id=u.id join wallet_secrets ws on ws.wallet_id=w.id where u.telegram_user_id=${id} limit 1`;
  const row=rows[0] as WalletRow|undefined; if(!row)return null;
  return {telegramUserId:Number(row.telegram_user_id),accountId:row.near_account_id,encryptedKey:{version:row.cipher_version as 1,iv:row.iv_base64,tag:row.auth_tag_base64,ciphertext:row.ciphertext_base64}};
 }
 async save(wallet:StoredWallet):Promise<void>{
  await this.sql`insert into users(telegram_user_id) values(${wallet.telegramUserId}) on conflict(telegram_user_id) do nothing`;
  const users=await this.sql`select id from users where telegram_user_id=${wallet.telegramUserId} limit 1`;
  const userId=(users[0] as {id:string}|undefined)?.id;if(!userId)throw new Error("Failed to create Neyro user record");
  await this.sql`insert into wallets(user_id,near_account_id,signer_ref) values(${userId},${wallet.accountId},${"near:"+wallet.accountId}) on conflict(near_account_id) do nothing`;
  const wallets=await this.sql`select id from wallets where near_account_id=${wallet.accountId} limit 1`;
  const walletId=(wallets[0] as {id:string}|undefined)?.id;if(!walletId)throw new Error("Failed to create Neyro wallet record");
  await this.sql`insert into wallet_secrets(wallet_id,cipher_version,iv_base64,auth_tag_base64,ciphertext_base64) values(${walletId},${wallet.encryptedKey.version},${wallet.encryptedKey.iv},${wallet.encryptedKey.tag},${wallet.encryptedKey.ciphertext}) on conflict(wallet_id) do nothing`;
 }
}