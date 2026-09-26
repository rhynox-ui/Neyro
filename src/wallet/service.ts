import { Account, KeyPair, keyToImplicitAddress, type KeyPairString } from "near-api-js";
import { config } from "../config.js";
import { createNearConnection } from "../near/client.js";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "../security/secrets.js";

type StoredWallet = {
  telegramUserId: number;
  accountId: string;
  encryptedKey: EncryptedSecret;
};

const wallets = new Map<number, StoredWallet>();

function requireMasterKey(): string {
  if (!config.NEYRO_MASTER_KEY) {
    throw new Error("Wallet service is not configured: NEYRO_MASTER_KEY is missing");
  }
  return config.NEYRO_MASTER_KEY;
}

function accountFor(accountId: string, privateKey: string): Account {
  const near = createNearConnection();
  return new Account(accountId, near.provider, privateKey as KeyPairString);
}

export type WalletInfo = {
  accountId: string;
  network: "mainnet" | "testnet";
};

export class WalletService {
  async getWallet(telegramUserId: number): Promise<WalletInfo | null> {
    const wallet = wallets.get(telegramUserId);
    if (!wallet) return null;

    return {
      accountId: wallet.accountId,
      network: config.NEAR_NETWORK
    };
  }

  async createWallet(telegramUserId: number): Promise<WalletInfo> {
    if (wallets.has(telegramUserId)) {
      return this.getWallet(telegramUserId) as Promise<WalletInfo>;
    }

    const keyPair = KeyPair.fromRandom("ed25519");
    const accountId = keyToImplicitAddress(keyPair.getPublicKey());
    const encryptedKey = encryptSecret(keyPair.toString(), requireMasterKey());

    wallets.set(telegramUserId, {
      telegramUserId,
      accountId,
      encryptedKey
    });

    return {
      accountId,
      network: config.NEAR_NETWORK
    };
  }

  async getSigningAccount(telegramUserId: number): Promise<Account> {
    const wallet = wallets.get(telegramUserId);
    if (!wallet) {
      throw new Error("No Neyro wallet exists for this Telegram account");
    }

    const privateKey = decryptSecret(wallet.encryptedKey, requireMasterKey());
    return accountFor(wallet.accountId, privateKey);
  }
}
