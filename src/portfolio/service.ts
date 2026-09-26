import { formatUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { z } from "zod";
import { RheaClient } from "../rhea/client.js";
import { ftMetadata } from "../near/ft.js";
import { FASTNEAR_API_URL, TRADING_ENABLED } from "../config.js";

export type PortfolioAsset = {
  symbol: string;
  contractId: string;
  decimals: number;
  balance: string;
  balanceBaseUnits: string;
};

const CACHE_TTL_MS = 30_000;
const FASTNEAR_TIMEOUT_MS = 8_000;
const MAX_ASSETS = 50;

type CachedPortfolio = {
  expiresAt: number;
  assets: PortfolioAsset[];
};

const cache = new Map<string, CachedPortfolio>();

const fastNearFtSchema = z.object({
  tokens: z.array(z.object({
    contract_id: z.string(),
    balance: z.string().nullable().optional()
  }))
});

/** Non-zero FT holdings from FastNEAR's /v1/account/{id}/ft response. */
export function parseFastNearTokens(json: unknown): { contractId: string; balance: bigint }[] {
  const { tokens } = fastNearFtSchema.parse(json);
  return tokens.flatMap((token) => {
    if (!token.balance || !/^\d+$/.test(token.balance)) return [];
    const balance = BigInt(token.balance);
    return balance > 0n ? [{ contractId: token.contract_id, balance }] : [];
  });
}

type TokenInfo = { symbol: string; decimals: number };

export class PortfolioService {
  constructor(
    private readonly rhea = new RheaClient(),
    private readonly fetcher: typeof fetch = fetch
  ) {}

  /**
   * Fungible-token holdings for an account. FastNEAR indexes balances, so a
   * single request replaces one ft_balance_of RPC call per listed token.
   * Balances can lag the chain by a few blocks; trade checks read RPC directly.
   */
  async getPortfolio(accountId: string): Promise<PortfolioAsset[]> {
    const cached = cache.get(accountId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.assets;
    }

    const response = await this.fetcher(
      `${FASTNEAR_API_URL}/v1/account/${encodeURIComponent(accountId)}/ft`,
      { signal: AbortSignal.timeout(FASTNEAR_TIMEOUT_MS) }
    );
    if (!response.ok) throw new Error(`FastNEAR returned HTTP ${response.status}`);
    const holdings = parseFastNearTokens(await response.json()).slice(0, MAX_ASSETS);

    const known = await this.knownTokens();
    const results = await Promise.allSettled(holdings.map(async ({ contractId, balance }) => {
      const info: TokenInfo = known.get(contractId) ?? await ftMetadata(contractId);
      return {
        symbol: info.symbol,
        contractId,
        decimals: info.decimals,
        balanceBaseUnits: balance.toString(),
        balance: formatUnits(balance.toString(), info.decimals)
      };
    }));

    const assets = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );

    cache.set(accountId, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      assets
    });

    return assets;
  }

  /** RHEA's list is mainnet-only; elsewhere every token uses on-chain metadata. */
  private async knownTokens(): Promise<Map<string, TokenInfo>> {
    if (!TRADING_ENABLED) return new Map();
    try {
      const tokens = await this.rhea.getNearTokens();
      return new Map(tokens.flatMap((token) => {
        const contractId = token.contractAddress ?? token.address;
        return contractId ? [[contractId, { symbol: token.symbol, decimals: token.decimals ?? 0 }]] : [];
      }));
    } catch {
      return new Map();
    }
  }
}
