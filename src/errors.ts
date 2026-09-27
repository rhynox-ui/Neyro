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
  if (error instanceof SwapSdkError) {
    const known = RHEA_MESSAGES[error.code];
    if (known) return `${fallback}: ${known}`;
    // A service response (code != 0) carries RHEA's own explanation, e.g.
    // an unsupported token or an amount below the minimum. Only that text is
    // shown; wrapped internal errors never carry apiCode.
    const apiCode = error.details?.apiCode;
    if (apiCode !== undefined && error.message) {
      return `${fallback}: RHEA says "${cleanServiceText(error.message)}" (code ${String(apiCode)})`;
    }
    return `${fallback} (RHEA: ${error.code})`;
  }
  return fallback;
}

const RHEA_MESSAGES: Partial<Record<string, string>> = {
  ROUTE_NOT_FOUND: "no swap route for this token and amount. Try a larger amount or check the pool has liquidity",
  RATE_LIMITED: "RHEA is busy. Try again in a few seconds",
  AUTH_FAILED: "the RHEA API key is missing or invalid (RHEA_API_TOKEN)",
  QUOTE_EXPIRED: "the quote expired. Tap BUY/SELL again for a fresh one",
  REQUEST_TIMEOUT: "RHEA took too long to answer. Try again"
};

/** One short line: no URLs, no control characters. */
function cleanServiceText(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "[link]").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 160);
}
