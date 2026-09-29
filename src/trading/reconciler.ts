import type { TxLookup } from "../near/execution.js";
import type { TradeRepository, TradeStatus, UnresolvedTrade } from "./repository.js";

/**
 * A signed NEAR transaction references a recent block hash and is only
 * valid for about a day. After this long, a hash no node has ever seen can
 * no longer land, so "not found" becomes a definite "never executed".
 */
export const TX_VALIDITY_MS = 25 * 60 * 60 * 1000;
/** Executing longer than this means the process that owned it died. */
export const STALE_EXECUTING_MS = 5 * 60 * 1000;

export type Resolution = {
  status: Extract<TradeStatus, "submitted" | "reverted" | "partial" | "failed">;
  failure?: string;
};

/**
 * Final status from the on-chain lookups of a trade's journaled hashes, or
 * undefined to check again later.
 */
export function decideResolution(lookups: readonly TxLookup[], ageMs: number): Resolution | undefined {
  // Hashes are journaled before broadcast, so no hashes means nothing was sent.
  if (lookups.length === 0) return { status: "failed" };

  const reverted = lookups.find((item) => item.result === "reverted");
  if (reverted) return { status: "reverted", failure: reverted.failure };
  if (lookups.every((item) => item.result === "executed")) return { status: "submitted" };

  // Some hashes are still unseen.
  if (ageMs < TX_VALIDITY_MS) return undefined;
  return lookups.some((item) => item.result === "executed") ? { status: "partial" } : { status: "failed" };
}

export function resolutionMessage(resolution: Resolution, txLinks: string[]): string {
  const links = txLinks.length ? `\n\n${txLinks.join("\n")}` : "";
  switch (resolution.status) {
    case "submitted":
      return `✅ Update on your earlier trade: it executed on chain. Check /portfolio for the tokens.${links}`;
    case "reverted":
      return `↩️ Update on your earlier trade: the swap failed on chain, so your tokens were not exchanged.${links}`;
    case "partial":
      return `⚠️ Update on your earlier trade: it only partly executed. Check /portfolio before trading again.${links}`;
    case "failed":
      return "❌ Update on your earlier trade: it never reached the chain. Nothing was spent; you can trade again.";
  }
}

export type ReconcilerDeps = {
  repository: TradeRepository;
  lookup(txHash: string, accountId: string): Promise<TxLookup>;
  notify(telegramUserId: number, text: string): Promise<void>;
  explorerLink(txHash: string): string;
  now?: () => number;
};

/** One pass over unresolved trades. Returns how many were resolved. */
export async function reconcileOnce(deps: ReconcilerDeps, limit = 25): Promise<number> {
  const now = deps.now ?? Date.now;
  const trades = await deps.repository.listUnresolved(STALE_EXECUTING_MS, limit);
  let resolved = 0;

  for (const trade of trades) {
    try {
      if (await reconcileTrade(deps, trade, now())) resolved++;
    } catch (error) {
      console.error("Trade reconciliation failed", { id: trade.idempotencyKey, error });
    }
  }
  return resolved;
}

async function reconcileTrade(deps: ReconcilerDeps, trade: UnresolvedTrade, now: number): Promise<boolean> {
  const lookups = await Promise.all(trade.txHashes.map((hash) =>
    deps.lookup(hash, trade.accountId).catch((): TxLookup => ({ result: "unknown" }))
  ));
  const resolution = decideResolution(lookups, now - trade.updatedAt.getTime());
  if (!resolution) return false;

  const won = await deps.repository.resolve(trade.telegramUserId, trade.idempotencyKey, {
    status: resolution.status,
    txHash: trade.txHashes.at(-1),
    errorCode: resolution.failure ?? `reconciled:${resolution.status}`
  });
  if (!won) return false;

  await deps.notify(trade.telegramUserId, resolutionMessage(resolution, trade.txHashes.map(deps.explorerLink)))
    .catch((error) => console.warn("Could not notify user of reconciled trade", error));
  return true;
}

/** Runs reconcileOnce every `intervalMs` until the returned stop() is called. */
export function startReconciler(deps: ReconcilerDeps, intervalMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    reconcileOnce(deps)
      .catch((error) => console.error("Reconciler pass failed", error))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
