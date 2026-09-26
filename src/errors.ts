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
  // Wrappers (e.g. the RHEA SDK's executor errors) keep ours as `cause`.
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof UserFacingError) return current.message;
    current = (current as { cause?: unknown }).cause;
  }
  if (error instanceof SwapSdkError) return `${fallback} (RHEA: ${error.code})`;
  return fallback;
}
