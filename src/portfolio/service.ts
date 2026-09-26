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

type FtBalanceResponse = string;

async function ftBalanceOf(contractId: string, accountId: string): Promise<string> {
  return withRpcFallback(async (provider) => {
    const result = await provider.callFunction({
      contractId,
      methodName: "ft_balance_of",
      args: { account_id: accountId }
    });
    return new TextDecoder().decode(result.result);
  });
}

function decodeJsonString(raw: string): FtBalanceResponse {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "string") throw new Error("Invalid ft_balance_of response");
    return parsed;
  } catch {
    throw new Error("Invalid fungible-token balance response");
  }
}

export class PortfolioService {
  constructor(private readonly rhea = new RheaClient()) {}

  async getPortfolio(accountId: string): Promise<PortfolioAsset[]> {
    const tokens = await this.rhea.getNearTokens();
    const assets: PortfolioAsset[] = [];

    for (const token of tokens) {
      const contractId = token.contractAddress ?? token.address;
      if (!contractId || contractId === WRAPPED_NEAR) continue;

      try {
        const raw = await ftBalanceOf(contractId, accountId);
        const baseUnits = decodeJsonString(raw);
        if (BigInt(baseUnits) === 0n) continue;

        assets.push({
          symbol: token.symbol,
          contractId,
          decimals: token.decimals ?? 0,
          balanceBaseUnits: baseUnits,
          balance: formatUnits(baseUnits, token.decimals ?? 0)
        });
      } catch (error) {
        console.warn(`Unable to read ${token.symbol} balance`, error);
      }
    }

    return assets;
  }
}
