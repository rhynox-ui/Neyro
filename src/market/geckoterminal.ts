import { safeUrl, type NearMarket } from "./dexscreener.js";

const GECKOTERMINAL_TOKEN_URL = "https://api.geckoterminal.com/api/v2/networks/near/tokens/";
const TIMEOUT_MS = 8_000;

type Json = Record<string, any>;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * GeckoTerminal token + top pools (JSON:API, `?include=top_pools`) as a
 * NearMarket, using the deepest pool for 24h stats. Null when the token
 * has no pools there.
 */
export function parseGeckoTerminalToken(json: unknown, address: string): NearMarket | null {
  const data = (json as Json)?.data;
  const token = data?.attributes as Json | undefined;
  if (!token) return null;
  const pools = (Array.isArray((json as Json).included) ? (json as Json).included : [])
    .filter((item: Json) => item?.type === "pool" && item.attributes)
    .sort((a: Json, b: Json) => (num(b.attributes.reserve_in_usd) ?? 0) - (num(a.attributes.reserve_in_usd) ?? 0));
  const pool = pools[0] as Json | undefined;
  if (!pool) return null;
  const p = pool.attributes as Json;

  const image = safeUrl(token.image_url);
  const createdAt = p.pool_created_at ? Date.parse(String(p.pool_created_at)) : NaN;
  const dex = String(pool.relationships?.dex?.data?.id ?? "DEX").slice(0, 24);
  return {
    address,
    name: String(token.name ?? token.symbol ?? address).slice(0, 48),
    symbol: String(token.symbol ?? "?").slice(0, 24),
    dex,
    pairLabel: String(p.name ?? `${token.symbol ?? "?"} / ?`).slice(0, 48),
    url: safeUrl(`https://www.geckoterminal.com/near/pools/${encodeURIComponent(String(p.address ?? ""))}`)
      ?? `https://www.geckoterminal.com/near/tokens/${encodeURIComponent(address)}`,
    priceUsd: num(token.price_usd) !== null ? String(token.price_usd) : null,
    marketCapUsd: num(token.market_cap_usd) ?? num(token.fdv_usd),
    fdvUsd: num(token.fdv_usd),
    liquidityUsd: num(p.reserve_in_usd) ?? num(token.total_reserve_in_usd),
    volume24hUsd: num(p.volume_usd?.h24) ?? num(token.volume_usd?.h24),
    priceChange24hPct: num(p.price_change_percentage?.h24),
    txns24hBuys: num(p.transactions?.h24?.buys),
    txns24hSells: num(p.transactions?.h24?.sells),
    pairCreatedAtMs: Number.isFinite(createdAt) ? createdAt : null,
    // GeckoTerminal returns a placeholder ".../missing.png" when there is no logo.
    imageUrl: image && !/missing/i.test(image) ? image : null,
    links: []
  };
}

export async function fetchGeckoTerminalMarket(address: string, fetcher: typeof fetch = fetch): Promise<NearMarket | null> {
  const response = await fetcher(`${GECKOTERMINAL_TOKEN_URL}${encodeURIComponent(address)}?include=top_pools`, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; NeyroBot/1.0)" },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`GeckoTerminal returned HTTP ${response.status} for ${address}: ${body}`);
  }
  return parseGeckoTerminalToken(await response.json(), address);
}
