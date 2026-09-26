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
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

export function encryptSecret(secret: string, masterKeyBase64: string): EncryptedSecret {
  const key = keyFromEnv(masterKeyBase64);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final()
  ]);

  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export function decryptSecret(
  encrypted: EncryptedSecret,
  masterKeyBase64: string
): string {
  if (encrypted.version !== 1) throw new Error("Unsupported secret version");

  const key = keyFromEnv(masterKeyBase64);
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(encrypted.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}
