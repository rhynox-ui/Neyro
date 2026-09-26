import { SwapSdkError } from "@rhea-finance/cross-chain-aggregation-dex";

/** An error whose message is written for, and safe to show to, end users. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/** Message for users; internal details (RPC bodies, stack traces, URLs) stay in logs. */
export function userMessage(error: unknown, fallback: string): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof SwapSdkError) return `${fallback} (RHEA: ${error.code})`;
  return fallback;
}
