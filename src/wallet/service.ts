import { Account, KeyPair, keyToImplicitAddress, type KeyPairString } from "near-api-js";
import { config } from "../config.js";
import { createNearConnection } from "../near/client.js";
import { decryptSecret, encryptSecret } from "../security/secrets.js";
import { InMemoryWalletRepository, PostgresWalletRepository, type WalletRepository } from "./repository.js";
import type { StoredWallet } from "./repository.js";

function requireMasterKey(): string {
  if (!config.NEYRO_MASTER_KEY) throw new Error("Wallet service is not configured: NEYRO_MASTER_KEY is missing");
  return config.NEYRO_MASTER_KEY;
}

function accountFor(accountId: string, privateKey: string): Account {
  const near = createNearConnection();
  return new Account(accountId, near.provider, privateKey as KeyPairString);
}

export type WalletInfo = { accountId: string; network: "mainnet" | "testnet" };

export class WalletService {
  private readonly repository: WalletRepository;

  constructor(repository?: WalletRepository) {
    if (!repository && config.NODE_ENV === "production" && !config.DATABASE_URL) {
      throw new Error("Production wallet storage requires DATABASE_URL");
    }

    this.repository = repository ?? (config.DATABASE_URL
      ? new PostgresWalletRepository(config.DATABASE_URL)
      : new InMemoryWalletRepository());
  }

  async getWallet(telegramUserId: number): Promise<WalletInfo | null> {
    const wallet = await this.repository.getByTelegramUserId(telegramUserId);
    return wallet ? { accountId: wallet.accountId, network: config.NEAR_NETWORK } : null;
  }

  async createWallet(telegramUserId: number): Promise<WalletInfo> {
    const existing = await this.repository.getByTelegramUserId(telegramUserId);
    if (existing) return { accountId: existing.accountId, network: config.NEAR_NETWORK };

    const keyPair = KeyPair.fromRandom("ed25519");
    const accountId = keyToImplicitAddress(keyPair.getPublicKey());
    const stored: StoredWallet = {
      telegramUserId,
      accountId,
      encryptedKey: encryptSecret(keyPair.toString(), requireMasterKey())
    };

    await this.repository.save(stored);

    const saved = await this.repository.getByTelegramUserId(telegramUserId);
    if (!saved) throw new Error("Wallet was created but could not be reloaded");

    return { accountId: saved.accountId, network: config.NEAR_NETWORK };
  }

  async getSigningAccount(telegramUserId: number): Promise<Account> {
    const wallet = await this.repository.getByTelegramUserId(telegramUserId);
    if (!wallet) throw new Error("No Neyro wallet exists for this Telegram account");
    return accountFor(wallet.accountId, decryptSecret(wallet.encryptedKey, requireMasterKey()));
  }
}