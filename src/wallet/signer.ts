export interface SignerRef {
  accountId: string;
}

export interface SignerVault {
  hasSigner(accountId: string): Promise<boolean>;
  sign(accountId: string, payload: Uint8Array): Promise<Uint8Array>;
}

/**
 * Production implementation will live behind this boundary.
 * Private keys must never be exposed to Telegram handlers, logs, or database records.
 */
export class UnconfiguredSignerVault implements SignerVault {
  async hasSigner(): Promise<boolean> {
    return false;
  }

  async sign(): Promise<Uint8Array> {
    throw new Error("Signer vault is not configured");
  }
}
