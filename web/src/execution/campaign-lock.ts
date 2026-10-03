/**
 * Runs `task` while holding an exclusive, cross-tab lock for one campaign.
 *
 * Two tabs executing or reconciling the same campaign could both read a
 * `pending` batch and sign it twice, or one tab could mark another tab's
 * in-progress `signing` batch as interrupted. The Web Locks API is shared by
 * every same-origin tab, and a lock held by a crashed or closed tab is released
 * by the browser, so a stale lock cannot block a campaign forever.
 *
 * When the API is unavailable execution is refused rather than run unguarded.
 */
export async function withCampaignLock<T>(
  campaignId: string,
  task: () => Promise<T>,
  locks: LockManager | undefined = typeof navigator === "undefined" ? undefined : navigator.locks
): Promise<T> {
  if (!locks) {
    throw new Error(
      "This browser does not support cross-tab campaign locking (Web Locks API); execution is disabled"
    );
  }

  let acquired = false;
  const result = await locks.request(
    `neyro-campaign:${campaignId}`,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) return undefined;
      acquired = true;
      return { value: await task() };
    }
  );

  if (!acquired || !result) {
    throw new Error(
      "This campaign is already executing or reconciling in another tab or window"
    );
  }
  return result.value;
}
