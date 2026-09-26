import { formatUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { RheaClient } from "../rhea/client.js";
import { withRpcFallback } from "../near/rpc.js";

export type PortfolioAsset = {
  symbol: string;
  contractId: string;
  decimals: number;
  balance: string;
  balanceBaseUnits: string;
};

const WRAPPED_NEAR = "wrap.near";
const CACHE_TTL_MS = 30_000;

type CachedPortfolio = {
  expiresAt: number;
  assets: PortfolioAsset[];
};

const cache = new Map<string, CachedPortfolio>();

async function ftBalanceOf(contractId: string, accountId: string): Promise<string> {
  return withRpcFallback(async (provider) => {
    // near-api-js 7 already decodes the JSON view result; NEP-141 returns
    // the balance as a JSON string (U128), so a string is the only valid shape.
    const result = await provider.callFunction({
      contractId,
      method: "ft_balance_of",
      args: { account_id: accountId }
    });
    return parseFtBalance(result);
  });
}

export function parseFtBalance(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Invalid ft_balance_of response");
  }
  return value;
}

export class PortfolioService {
  constructor(private readonly rhea = new RheaClient()) {}

  async getPortfolio(accountId: string): Promise<PortfolioAsset[]> {
    const cached = cache.get(accountId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.assets;
    }

    const tokens = await this.rhea.getNearTokens();
    const candidates = tokens.filter((token) => {
      const contractId = token.contractAddress ?? token.address;
      return Boolean(contractId) && contractId !== WRAPPED_NEAR;
    });

    const results = await Promise.allSettled(
      candidates.map(async (token) => {
        const contractId = token.contractAddress ?? token.address;
        if (!contractId) return null;

        const baseUnits = await ftBalanceOf(contractId, accountId);

        if (BigInt(baseUnits) === 0n) return null;

        return {
          symbol: token.symbol,
          contractId,
          decimals: token.decimals ?? 0,
          balanceBaseUnits: baseUnits,
          balance: formatUnits(baseUnits, token.decimals ?? 0)
        };
      })
    );

    const assets = results.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : []
    );

    cache.set(accountId, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      assets
    });

    return assets;
  }
}
