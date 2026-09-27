import { safeUrl, type NearMarket, type TokenLink } from "./dexscreener.js";
import { defaultStateStore, type StateStore } from "../state/store.js";

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
    // NEAR pools here report the DEX contract's date (e.g. 1252d for a 16h-old
    // UMBRA pool), not the pair's, so it isn't shown.
    pairCreatedAtMs: null,
    // GeckoTerminal returns a placeholder ".../missing.png" when there is no logo.
    imageUrl: image && !/missing/i.test(image) ? image : null,
    links: []
  };
}

async function fetchTokenJson(url: string, headers: Record<string, string>, fetcher: typeof fetch, label: string, address: string): Promise<unknown | null> {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; NeyroBot/1.0)", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`${label} returned HTTP ${response.status} for ${address}: ${body}`);
  }
  return response.json();
}

/** Keyless GeckoTerminal API (rate-limited per IP). */
export async function fetchGeckoTerminalMarket(address: string, fetcher: typeof fetch = fetch): Promise<NearMarket | null> {
  const json = await fetchTokenJson(`${GECKOTERMINAL_TOKEN_URL}${encodeURIComponent(address)}?include=top_pools`, {}, fetcher, "GeckoTerminal", address);
  return json === null ? null : parseGeckoTerminalToken(json, address);
}

/**
 * CoinGecko's keyed on-chain API: the same GeckoTerminal data (JSON:API
 * token + top pools), limited per key rather than per shared IP.
 */
export async function fetchCoinGeckoOnchainMarket(
  address: string,
  apiKey: string,
  plan: "demo" | "pro" = "demo",
  fetcher: typeof fetch = fetch
): Promise<NearMarket | null> {
  const host = plan === "pro" ? "https://pro-api.coingecko.com" : "https://api.coingecko.com";
  const header = plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key";
  const url = `${host}/api/v3/onchain/networks/near/tokens/${encodeURIComponent(address)}?include=top_pools`;
  const json = await fetchTokenJson(url, { [header]: apiKey }, fetcher, "CoinGecko", address);
  const market = json === null ? null : parseGeckoTerminalToken(json, address);
  if (!market) return null;
  const links = await coinGeckoTokenLinks(address, `${host}/api/v3/onchain/networks/near/tokens/${encodeURIComponent(address)}/info`, { [header]: apiKey }, fetcher)
    .catch(() => []);
  return { ...market, links };
}

/** Website and socials from CoinGecko's token info (team-submitted handles). */
export function parseCoinGeckoTokenInfo(json: unknown): TokenLink[] {
  const info = (json as Json)?.data?.attributes as Json | undefined;
  if (!info) return [];
  const links: TokenLink[] = [];
  const push = (label: string, value: string | null) => {
    if (value && !links.some((link) => link.url === value)) links.push({ label, url: value });
  };
  const handle = (value: unknown) => {
    const text = String(value ?? "").trim().replace(/^@/, "");
    return /^[A-Za-z0-9_]{1,64}$/.test(text) ? text : null;
  };
  for (const site of Array.isArray(info.websites) ? info.websites : []) push("Website", safeUrl(site));
  const twitter = handle(info.twitter_handle);
  if (twitter) push("X", `https://x.com/${twitter}`);
  const telegram = handle(info.telegram_handle);
  if (telegram) push("Telegram", `https://t.me/${telegram}`);
  push("Discord", safeUrl(info.discord_url));
  return links.slice(0, 4);
}

const LINKS_TTL_MS = 24 * 60 * 60 * 1000;

/** Links change rarely; cached a day so card views don't spend API quota. */
async function coinGeckoTokenLinks(
  address: string,
  url: string,
  headers: Record<string, string>,
  fetcher: typeof fetch,
  store: StateStore = defaultStateStore()
): Promise<TokenLink[]> {
  const key = `cglinks:${address}`;
  const cached = await store.get<TokenLink[]>(0, key).catch(() => null);
  if (cached) return cached;
  const json = await fetchTokenJson(url, headers, fetcher, "CoinGecko info", address);
  const links = json === null ? [] : parseCoinGeckoTokenInfo(json);
  await store.set(0, key, links, LINKS_TTL_MS).catch(() => {});
  return links;
}
