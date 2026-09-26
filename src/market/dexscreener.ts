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
  for (const site of Array.isArray(info?.websites) ? info.websites : []) push("Website", site?.url);
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
export async function fetchNearMarket(
  address: string,
  fetcher: typeof fetch = fetch
): Promise<NearMarket | null> {
  const response = await fetcher(`${DEXSCREENER_NEAR_TOKENS_URL}${encodeURIComponent(address)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`DexScreener returned HTTP ${response.status}`);
  return parseDexScreenerPairs(await response.json(), address);
}
