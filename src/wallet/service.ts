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

  /** Import an implicit NEAR wallet from an ed25519 private key. */
  async importWallet(telegramUserId: number, privateKeyInput: string): Promise<WalletInfo> {
    const privateKey = privateKeyInput.trim();
    if (!privateKey.startsWith("ed25519:")) {
      throw new UserFacingError("Invalid NEAR private key. Send the full ed25519:... private key.");
    }

    let keyPair: KeyPair;
    try {
      keyPair = KeyPair.fromString(privateKey as KeyPairString);
    } catch {
      throw new UserFacingError("Invalid NEAR private key. Check that you copied the complete ed25519:... key.");
    }

    const accountId = keyToImplicitAddress(keyPair.getPublicKey());
    const existing = await this.repository.getByAccount(telegramUserId, accountId);
    if (existing) {
      await this.repository.setActive(telegramUserId, accountId);
      return { accountId, network: config.NEAR_NETWORK };
    }

    const wallets = await this.repository.list(telegramUserId);
    if (wallets.length >= MAX_WALLETS) {
      throw new UserFacingError(`You already have ${MAX_WALLETS} wallets, the maximum`);
    }

    const stored: StoredWallet = {
      telegramUserId,
      accountId,
      encryptedKey: encryptSecret(privateKey, requireMasterKey(), walletKeyContext(accountId))
    };
    await this.repository.save(stored);

    const saved = await this.repository.getByAccount(telegramUserId, accountId);
    if (!saved) {
      throw new UserFacingError("That wallet could not be imported. It may already belong to another Neyro account.");
    }

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
   * The active wallet's private key ("ed25519:..."), for the user to back up
   * or import into another wallet app. Only ever sent to the owner in a
   * private chat; never logged.
   */
  async exportPrivateKey(telegramUserId: number): Promise<{ accountId: string; privateKey: string }> {
    const wallet = await this.repository.getByTelegramUserId(telegramUserId);
    if (!wallet) throw new UserFacingError("No wallet yet. Use /wallet to create one.");
    return { accountId: wallet.accountId, privateKey: unlockWalletKey(wallet, requireMasterKey()) };
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
