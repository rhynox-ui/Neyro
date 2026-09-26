/**
 * Tries a list of interchangeable sources (RPC endpoints, market-data APIs)
 * in order until one succeeds. A source that fails is put on a short
 * cooldown and tried last until it expires, so a rate-limited provider
 * doesn't add latency to every request. Cooldowns are per process (per
 * isolate on Cloudflare Workers).
 */
export type Source<T> = { name: string; run: () => Promise<T> };

export type FallbackOptions = {
  /** How long a failed source is deprioritised. */
  cooldownMs?: number;
  /** Errors that another source would answer identically: rethrown at once. */
  isDefinitive?: (error: unknown) => boolean;
  /** Treat this result as "no data here" and try the next source. */
  isMiss?: (value: unknown) => boolean;
  now?: () => number;
};

const cooldowns = new Map<string, number>();

export function coolingDown(name: string, now = Date.now()): boolean {
  return (cooldowns.get(name) ?? 0) > now;
}

/** Test hook. */
export function resetCooldowns(): void {
  cooldowns.clear();
}

/**
 * Result of the first source that succeeds (and isn't a miss). Throws the
 * last error when every source fails; returns the last miss when all miss.
 */
export async function firstSuccess<T>(sources: readonly Source<T>[], options: FallbackOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 30_000;
  // Healthy sources first, cooling ones as a last resort, each group in order.
  const ordered = [
    ...sources.filter((source) => !coolingDown(source.name, now())),
    ...sources.filter((source) => coolingDown(source.name, now()))
  ];

  let lastError: unknown = new Error("No sources configured");
  let miss: { value: T } | undefined;
  for (const source of ordered) {
    try {
      const value = await source.run();
      cooldowns.delete(source.name);
      if (options.isMiss?.(value)) {
        miss = { value };
        continue;
      }
      return value;
    } catch (error) {
      if (options.isDefinitive?.(error)) throw error;
      cooldowns.set(source.name, now() + cooldownMs);
      lastError = error;
      console.warn(`${source.name} failed; trying the next source`, String(error).slice(0, 200));
    }
  }
  if (miss) return miss.value;
  throw lastError;
}
