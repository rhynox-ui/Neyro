function normalizeTokenList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function extractRheaRouteTokens(
  rawQuote: unknown,
  fallbackTokens: readonly string[]
): string[] {
  if (rawQuote && typeof rawQuote === "object") {
    const raw = rawQuote as Record<string, unknown>;
    const candidates = [
      raw.tokens,
      raw.route && typeof raw.route === "object"
        ? (raw.route as Record<string, unknown>).tokens
        : undefined
    ];

    for (const candidate of candidates) {
      const tokens = normalizeTokenList(candidate);
      if (tokens.length > 0) {
        return [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];
      }
    }
  }

  return [...new Set(fallbackTokens.map((token) => token.trim()).filter(Boolean))];
}
