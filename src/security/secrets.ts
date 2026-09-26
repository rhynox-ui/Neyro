import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function keyFromEnv(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("NEYRO_MASTER_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export type EncryptedSecret = {
  /** 1 = no associated data (legacy); 2 = bound to associated data. */
  version: 1 | 2;
  iv: string;
  tag: string;
  ciphertext: string;
};

/**
 * AES-256-GCM. When `associatedData` is given (version 2), the ciphertext is
 * bound to it: decrypting with different associated data fails, so a stored
 * secret can't be moved to another wallet row.
 */
export function encryptSecret(
  secret: string,
  masterKeyBase64: string,
  associatedData?: string
): EncryptedSecret {
  const key = keyFromEnv(masterKeyBase64);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (associatedData !== undefined) cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final()
  ]);

  return {
    version: associatedData === undefined ? 1 : 2,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export function decryptSecret(
  encrypted: EncryptedSecret,
  masterKeyBase64: string,
  associatedData?: string
): string {
  if (encrypted.version !== 1 && encrypted.version !== 2) {
    throw new Error("Unsupported secret version");
  }
  if (encrypted.version === 2 && associatedData === undefined) {
    throw new Error("Associated data is required for version 2 secrets");
  }

  const key = keyFromEnv(masterKeyBase64);
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(encrypted.iv, "base64")
  );
  if (encrypted.version === 2) decipher.setAAD(Buffer.from(associatedData!, "utf8"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}
