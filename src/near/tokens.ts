export const NATIVE_NEAR = "near";

export type TokenMetadata = {
  contractId: string;
  symbol: string;
  decimals: number;
};

export function normalizeTokenId(value: string): string {
  const token = value.trim().toLowerCase();
  if (!token) throw new Error("Token is required");
  if (token === "near") return NATIVE_NEAR;
  return token;
}

export function assertValidTokenId(value: string): string {
  const token = normalizeTokenId(value);
  if (token === NATIVE_NEAR) return token;
  if (token.length > 64) throw new Error("Token identifier is too long");
  if (!/^[a-z0-9._-]+$/.test(token)) {
    throw new Error("Invalid NEAR token identifier");
  }
  return token;
}
