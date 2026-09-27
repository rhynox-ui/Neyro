import { defaultStateStore, type StateStore } from "../state/store.js";
import { firstSuccess, type Source } from "../net/fallback.js";
import { fetchCoinGeckoOnchainMarket, fetchGeckoTerminalMarket } from "./geckoterminal.js";
import { config } from "../config.js";

const DEXSCREENER_NEAR_TOKENS_URL = "https://api.dexscreener.com/tokens/v1/near/";
const TIMEOUT_MS = 8_000;

export type TokenLink = { label: string; url: string };

/** Market snapshot for a NEAR token's deepest DexScreener pair. */
export type NearMarket = {
  address: string;
  name: string;
  symbol: string;
  dex: string;
  pairLabel: string;
  url: string;
  priceUsd: string | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  txns24hBuys: number | null;
  txns24hSells: number | null;
  pairCreatedAtMs: number | null;
  imageUrl: string | null;
  links: TokenLink[];
  /** Set when DexScreener was unavailable and this is the last good result. */
  cachedAtMs?: number;
  /** Priced from the token's RHEA pool on chain; no 24h stats. */
  onchain?: boolean;
};

// Profile fields are submitted by token teams, so labels come from a fixed
// set and only http(s) URLs survive; a token can't name its own link.
const SOCIAL_LABELS: Record<string, string> = {
  twitter: "X",
  x: "X",
  telegram: "Telegram",
  discord: "Discord",
  github: "GitHub",
  medium: "Medium",
  reddit: "Reddit",
  youtube: "YouTube"
};

export function safeUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type Pair = Record<string, any>;

function extractLinks(info: Pair | undefined): TokenLink[] {
  const links: TokenLink[] = [];
  const seen = new Set<string>();
  const push = (label: string, value: unknown) => {
    const url = safeUrl(value);
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ label, url });
  };
  for (const site of Array.isArray(info?.websites) ? info.websites : []) {
    // Team-supplied labels ("Docs") are kept only when short and plain.
    const label = String(site?.label ?? "").trim();
    push(/^[A-Za-z0-9 ]{1,12}$/.test(label) ? label : "Website", site?.url);
  }
  for (const social of Array.isArray(info?.socials) ? info.socials : []) {
    const label = SOCIAL_LABELS[String(social?.type ?? "").toLowerCase()];
    if (label) push(label, social?.url);
  }
  return links.slice(0, 4);
}

/** Picks the deepest NEAR pair containing `address` and normalizes it. */
export function parseDexScreenerPairs(json: unknown, address: string): NearMarket | null {
  const pairs: Pair[] = Array.isArray(json)
    ? json
    : Array.isArray((json as { pairs?: unknown })?.pairs) ? (json as { pairs: Pair[] }).pairs : [];
  const needle = address.toLowerCase();
  const matches = (value: unknown) => String(value ?? "").toLowerCase() === needle;

  const best = pairs
    .filter((pair) => pair?.chainId === "near" &&
      (matches(pair.baseToken?.address) || matches(pair.quoteToken?.address)))
    .sort((a, b) => (num(b.liquidity?.usd) ?? 0) - (num(a.liquidity?.usd) ?? 0))[0];
  if (!best) return null;

  const token = matches(best.baseToken?.address) ? best.baseToken : best.quoteToken;
  return {
    address,
    name: String(token?.name ?? token?.symbol ?? address).slice(0, 48),
    symbol: String(token?.symbol ?? "?").slice(0, 24),
    dex: String(best.dexId ?? "DEX").slice(0, 24),
    pairLabel: `${String(best.baseToken?.symbol ?? "?").slice(0, 24)} / ${String(best.quoteToken?.symbol ?? "?").slice(0, 24)}`,
    url: safeUrl(best.url) ?? `https://dexscreener.com/near/${encodeURIComponent(address)}`,
    // Price is only meaningful for the base token of the pair.
    priceUsd: matches(best.baseToken?.address) && num(best.priceUsd) !== null ? String(best.priceUsd) : null,
    marketCapUsd: num(best.marketCap),
    fdvUsd: num(best.fdv),
    liquidityUsd: num(best.liquidity?.usd),
    volume24hUsd: num(best.volume?.h24),
    priceChange24hPct: num(best.priceChange?.h24),
    txns24hBuys: num(best.txns?.h24?.buys),
    txns24hSells: num(best.txns?.h24?.sells),
    pairCreatedAtMs: num(best.pairCreatedAt),
    imageUrl: safeUrl(best.info?.imageUrl),
    links: extractLinks(best.info)
  };
}

/** Null when DexScreener has no NEAR pair yet (common for brand-new launches). */
/**
 * Market-data sources in order. With a CoinGecko key its keyed on-chain API
 * goes first: it isn't subject to the shared-IP rate limits that keyless
 * DexScreener and GeckoTerminal apply to Cloudflare Workers.
 */
function marketSources(address: string, fetcher: typeof fetch): Source<NearMarket | null>[] {
  const coingecko: Source<NearMarket | null>[] = config.COINGECKO_API_KEY
    ? [{
        name: "market:coingecko",
        run: () => fetchCoinGeckoOnchainMarket(address, config.COINGECKO_API_KEY!, config.COINGECKO_API_PLAN, fetcher)
      }]
    : [];
  return [
    ...coingecko,
    { name: "market:dexscreener", run: () => requestMarket(address, fetcher) },
    { name: "market:geckoterminal", run: () => fetchGeckoTerminalMarket(address, fetcher) }
  ];
}

/** Last good DexScreener result per token, served when DexScreener refuses. */
const LAST_GOOD_TTL_MS = 6 * 60 * 60 * 1000;
/** Global (not per-user) keys live under user id 0 in the state store. */
const GLOBAL = 0;

type Cached = { market: NearMarket; fetchedAtMs: number };

async function requestMarket(address: string, fetcher: typeof fetch): Promise<NearMarket | null> {
  const url = `${DEXSCREENER_NEAR_TOKENS_URL}${encodeURIComponent(address)}`;
  const response = await fetcher(url, {
    // DexScreener sits behind bot protection; requests without these headers
    // (the Workers default) can be refused.
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; NeyroBot/1.0; +https://t.me)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // On Cloudflare Workers, cache successful responses at the edge briefly so
    // repeated views of a token don't each hit DexScreener. Ignored on Node.
    cf: { cacheTtlByStatus: { "200-299": 20, "400-599": 0 } }
  } as RequestInit);
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`DexScreener returned HTTP ${response.status} for ${address}: ${body}`);
  }
  const json = await response.json();
  const market = parseDexScreenerPairs(json, address);
  if (!market) console.warn("DexScreener has no NEAR pair", { address, pairs: Array.isArray(json) ? json.length : "n/a" });
  return market;
}

/**
 * Market data for a NEAR token. DexScreener rate-limits by IP (HTTP 429,
 * Cloudflare error 1015), and Workers share egress IPs, so refusals happen
 * regardless of Neyro's own traffic. On failure the last good result (up to
 * 6h old) is returned with `cachedAtMs` set; callers should refresh the price
 * from the chain when they can. Null when DexScreener has no NEAR pair.
 */
export async function fetchNearMarket(
  address: string,
  fetcher: typeof fetch = fetch,
  store: StateStore = defaultStateStore()
): Promise<NearMarket | null> {
  const key = `dex:${address}`;
  try {
    // DexScreener first, then GeckoTerminal. A source that fails (e.g. a
    // rate limit) is skipped for a minute; "no pair" moves on to the next.
    const market = await firstSuccess<NearMarket | null>(marketSources(address, fetcher), {
      cooldownMs: 60_000,
      isMiss: (value) => value === null
    });
    if (market) {
      await store.set(GLOBAL, key, { market, fetchedAtMs: Date.now() } satisfies Cached, LAST_GOOD_TTL_MS)
        .catch((error) => console.warn("Could not cache market result", error));
    }
    return market;
  } catch (error) {
    const cached = await store.get<Cached>(GLOBAL, key).catch(() => null);
    if (cached) {
      console.warn("Market sources unavailable; using cached market", { address, error: String(error) });
      return { ...cached.market, cachedAtMs: cached.fetchedAtMs };
    }
    throw error;
  }
}
