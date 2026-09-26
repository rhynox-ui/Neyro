import { Account, KeyPair, keyToImplicitAddress, type KeyPairString } from "near-api-js";
import { config } from "../config.js";
import { createNearConnection } from "../near/client.js";
import { decryptSecret, encryptSecret } from "../security/secrets.js";
import { InMemoryWalletRepository, PostgresWalletRepository, type WalletRepository } from "./repository.js";
import type { StoredWallet, WalletSummary } from "./repository.js";
import { UserFacingError } from "../errors.js";

export const MAX_WALLETS = 5;

function requireMasterKey(): string {
  if (!config.NEYRO_MASTER_KEY) throw new Error("Wallet service is not configured: NEYRO_MASTER_KEY is missing");
  return config.NEYRO_MASTER_KEY;
}

/** Associated data binding an encrypted key to its wallet. */
export function walletKeyContext(accountId: string): string {
  return `neyro:wallet-key:v2:${accountId}`;
}

/**
 * Decrypts a wallet key and checks that it controls the stored implicit
 * account, which also catches legacy (v1) rows that were swapped between users.
 */
export function unlockWalletKey(wallet: StoredWallet, masterKey: string): string {
  const secret = decryptSecret(
    wallet.encryptedKey,
    masterKey,
    wallet.encryptedKey.version === 2 ? walletKeyContext(wallet.accountId) : undefined
  );
  const derived = keyToImplicitAddress(KeyPair.fromString(secret as KeyPairString).getPublicKey());
  if (derived !== wallet.accountId) {
    throw new Error("Stored wallet key does not match its account");
  }
  return secret;
}

function accountFor(accountId: string, privateKey: string): Account {
  const near = createNearConnection();
  return new Account(accountId, near.provider, privateKey as KeyPairString);
}

export type WalletInfo = { accountId: string; network: "mainnet" | "testnet" };

export class WalletService {
  private readonly repository: WalletRepository;

  constructor(repository?: WalletRepository) {
    this.repository = repository ?? (config.DATABASE_URL
      ? new PostgresWalletRepository(config.DATABASE_URL)
      : new InMemoryWalletRepository());
  }

  async getWallet(telegramUserId: number): Promise<WalletInfo | null> {
    const wallet = await this.repository.getByTelegramUserId(telegramUserId);
    return wallet ? { accountId: wallet.accountId, network: config.NEAR_NETWORK } : null;
  }

  /** The user's wallet, creating their first one if they have none. */
  async createWallet(telegramUserId: number): Promise<WalletInfo> {
    const existing = await this.repository.getByTelegramUserId(telegramUserId);
    if (existing) return { accountId: existing.accountId, network: config.NEAR_NETWORK };
    return this.addWallet(telegramUserId);
  }

  /** Creates another wallet (up to MAX_WALLETS) and makes it active. */
  async addWallet(telegramUserId: number): Promise<WalletInfo> {
    const wallets = await this.repository.list(telegramUserId);
    if (wallets.length >= MAX_WALLETS) {
      throw new UserFacingError(`You already have ${MAX_WALLETS} wallets, the maximum`);
    }

    const keyPair = KeyPair.fromRandom("ed25519");
    const accountId = keyToImplicitAddress(keyPair.getPublicKey());
    const stored: StoredWallet = {
      telegramUserId,
      accountId,
      encryptedKey: encryptSecret(keyPair.toString(), requireMasterKey(), walletKeyContext(accountId))
    };

    await this.repository.save(stored);

    const saved = await this.repository.getByAccount(telegramUserId, accountId);
    if (!saved) throw new Error("Wallet was created but could not be reloaded");

    return { accountId: saved.accountId, network: config.NEAR_NETWORK };
  }

  async listWallets(telegramUserId: number): Promise<WalletSummary[]> {
    return this.repository.list(telegramUserId);
  }

  async switchWallet(telegramUserId: number, accountId: string): Promise<void> {
    if (!(await this.repository.setActive(telegramUserId, accountId))) {
      throw new UserFacingError("That wallet isn't one of yours");
    }
  }

  /**
   * Signing account for the active wallet, or for `accountId` when given.
   * A quote or withdrawal passes the account it was made for, so switching
   * wallets before confirming can't sign with a different one.
   */
  async getSigningAccount(telegramUserId: number, accountId?: string): Promise<Account> {
    const wallet = accountId
      ? await this.repository.getByAccount(telegramUserId, accountId)
      : await this.repository.getByTelegramUserId(telegramUserId);
    if (!wallet) throw new Error("No Neyro wallet exists for this Telegram account");
    return accountFor(wallet.accountId, unlockWalletKey(wallet, requireMasterKey()));
  }
}
