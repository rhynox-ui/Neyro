import type { NearRpcClient } from "./near/rpc";
import { getFtBalance, getFtMetadata, getStorageBalance, isRegistered } from "./near/ft";
import type { SenderBalance } from "./airdrop-core";

export type SenderPreflight = SenderBalance & {
  storage: "registered" | "not-registered" | "unknown";
};

export type CampaignPreflight = {
  tokenContract: string;
  decimals: number;
  senders: SenderPreflight[];
  totalTokenBalance: bigint;
  totalRequired: bigint;
  enoughTokenBalance: boolean;
};

export async function preflightSenders(
  rpc: NearRpcClient,
  tokenContract: string,
  senderIds: readonly string[],
  totalRequired: bigint
): Promise<CampaignPreflight> {
  if (!tokenContract) throw new Error("token contract is required");
  if (senderIds.length === 0) throw new Error("at least one sender is required");
  if (totalRequired < 0n) throw new Error("total required amount cannot be negative");

  const metadata = await getFtMetadata(rpc, tokenContract);
  const uniqueSenders = [...new Set(senderIds)];
  const senders = await Promise.all(
    uniqueSenders.map(async (senderId): Promise<SenderPreflight> => {
      const [account, tokenBalance, storage] = await Promise.all([
        rpc.viewAccount(senderId),
        getFtBalance(rpc, tokenContract, senderId),
        getStorageBalance(rpc, tokenContract, senderId)
      ]);

      return {
        senderId,
        tokenBalance,
        nativeBalance: BigInt(account.amount),
        storage:
          storage === null
            ? "unknown"
            : isRegistered(storage)
              ? "registered"
              : "not-registered"
      };
    })
  );

  const totalTokenBalance = senders.reduce(
    (total, sender) => total + sender.tokenBalance,
    0n
  );

  return {
    tokenContract,
    decimals: metadata.decimals,
    senders,
    totalTokenBalance,
    totalRequired,
    enoughTokenBalance: totalTokenBalance >= totalRequired
  };
}
