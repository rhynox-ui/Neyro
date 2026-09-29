export const NATIVE_NEAR = "near";

// NEAR account id rules: 2-64 chars, lowercase alphanumeric parts separated
// by "." with single "-" or "_" inside parts. Implicit accounts are 64 hex.
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function normalizeTokenId(value: string): string {
  const token = value.trim().toLowerCase();
  if (!token) throw new Error("Token is required");
  if (token === "near") return NATIVE_NEAR;
  return token;
}

export function isValidAccountId(value: string): boolean {
  return ACCOUNT_ID.test(value);
}

/** True for input that names a contract rather than a ticker symbol. */
export function looksLikeContractId(value: string): boolean {
  return isValidAccountId(value) && (value.includes(".") || /^[0-9a-f]{64}$/.test(value));
}
