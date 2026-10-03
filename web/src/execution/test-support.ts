/**
 * Minimal in-memory Web Locks implementation for tests. Supports the
 * exclusive `ifAvailable` requests used by `withCampaignLock`.
 */
export function testLocks(): LockManager {
  const held = new Set<string>();
  const manager = {
    async request(
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>
    ) {
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        throw new Error("test lock manager only supports ifAvailable requests");
      }
      held.add(name);
      try {
        return await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        held.delete(name);
      }
    },
    async query() {
      return { held: [], pending: [] };
    }
  };
  return manager as unknown as LockManager;
}
