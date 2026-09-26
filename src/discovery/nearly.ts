import { withRpcFallback } from "../near/rpc.js";
import { safeUrl, type NearMarket } from "../market/dexscreener.js";

/**
 * NEARly (nearly.trade) factory. Every launch mints its whole supply into a
 * single-sided RHEA DCL position, so tokens trade from the block they are
 * created; the factory's view methods are the launch feed.
 */
export const NEARLY_FACTORY = "nearlytrade.near";

export type NearlyLaunch = {
  id: number;
  token: string;
  name: string;
  symbol: string;
  creator: string;
  createdAtMs: number;
  /** The pair's other asset: wrap.near or another token such as NEARLY. */
  quote: string;
  links: { label: string; url: string }[];
};

type RawLaunch = {
  id?: unknown;
  token?: unknown;
  name?: unknown;
  symbol?: unknown;
  creator?: unknown;
  created_at_ms?: unknown;
  quote?: unknown;
  step?: unknown;
  links?: { website?: unknown; twitter?: unknown; telegram?: unknown };
};

function parseLaunch(raw: RawLaunch): NearlyLaunch | null {
  // Only completed launches have a funded pool; others may still fail.
  if (raw.step !== "Done") return null;
  if (typeof raw.token !== "string" || typeof raw.symbol !== "string") return null;
  const id = Number(raw.id);
  if (!Number.isSafeInteger(id) || id < 0) return null;

  const links = [
    ["Website", raw.links?.website],
    ["X", raw.links?.twitter],
    ["Telegram", raw.links?.telegram]
  ].flatMap(([label, value]) => {
    const url = safeUrl(value);
    return url ? [{ label: label as string, url }] : [];
  });

  return {
    id,
    token: raw.token,
    name: String(raw.name ?? raw.symbol).slice(0, 48),
    symbol: raw.symbol.slice(0, 24),
    creator: String(raw.creator ?? ""),
    createdAtMs: Number(raw.created_at_ms) || 0,
    quote: typeof raw.quote === "string" ? raw.quote : "wrap.near",
    links
  };
}

export function parseLaunches(json: unknown): NearlyLaunch[] {
  if (!Array.isArray(json)) throw new Error("Invalid get_launches response");
  return json.flatMap((raw) => {
    const launch = raw && typeof raw === "object" ? parseLaunch(raw as RawLaunch) : null;
    return launch ? [launch] : [];
  });
}

/** Newest completed launches first. */
export async function fetchRecentLaunches(limit = 8): Promise<NearlyLaunch[]> {
  // Fetch a few extra: in-flight or failed launches are filtered out.
  const raw = await withRpcFallback((provider) => provider.callFunction({
    contractId: NEARLY_FACTORY,
    method: "get_launches",
    args: { from_index: 0, limit: Math.min(limit * 2, 50) }
  }));
  return parseLaunches(raw).slice(0, limit);
}

export async function fetchLaunch(id: number): Promise<NearlyLaunch | null> {
  const raw = await withRpcFallback((provider) => provider.callFunction({
    contractId: NEARLY_FACTORY,
    method: "get_launch",
    args: { launch_id: String(id) }
  }));
  return raw && typeof raw === "object" ? parseLaunch(raw as RawLaunch) : null;
}

export function isNearlyToken(contractId: string): boolean {
  return contractId.endsWith(`.${NEARLY_FACTORY}`);
}

export async function fetchLaunchByToken(token: string): Promise<NearlyLaunch | null> {
  const raw = await withRpcFallback((provider) => provider.callFunction({
    contractId: NEARLY_FACTORY,
    method: "get_launch_by_token",
    args: { token }
  }));
  return raw && typeof raw === "object" ? parseLaunch(raw as RawLaunch) : null;
}

/**
 * Minimal market card from the factory's own launch record, for tokens
 * too new to have a DexScreener pair. Prices stay unknown.
 */
export function launchAsMarket(launch: NearlyLaunch): NearMarket {
  return {
    address: launch.token,
    name: launch.name,
    symbol: launch.symbol,
    dex: "rhea · NEARly",
    pairLabel: `${launch.symbol} / ${launch.quote === "wrap.near" ? "NEAR" : launch.quote.split(".")[0]!.toUpperCase()}`,
    url: `https://dexscreener.com/near/${encodeURIComponent(launch.token)}`,
    priceUsd: null,
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    priceChange24hPct: null,
    txns24hBuys: null,
    txns24hSells: null,
    pairCreatedAtMs: launch.createdAtMs || null,
    imageUrl: null,
    links: launch.links
  };
}
