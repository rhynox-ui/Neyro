import type { NearRpcClient } from "./near/rpc";
import {
  getFtBalance,
  getFtMetadata,
  getStorageBalance,
  getStorageRegistrationState,
  isRegistered
} from "./near/ft";
import type { SenderBalance } from "./airdrop-core";

export type SenderPreflight = SenderBalance & {
  storage: "registered" | "not-registered" | "unknown";
};

export type RecipientRegistrationPreflight = {
  checked: number;
  registered: number;
  notRegistered: number;
  unsupported: number;
  sampleNotRegistered: string[];
};

export type CampaignPreflight = {
  tokenContract: string;
  decimals: number;
  senders: SenderPreflight[];
  totalTokenBalance: bigint;
  totalRequired: bigint;
  enoughTokenBalance: boolean;
  recipientRegistration?: RecipientRegistrationPreflight;
};

export async function preflightSenders(
  rpc: NearRpcClient,
  tokenContract: string,
  senderIds: readonly string[],
  totalRequired: bigint,
  recipientIds: readonly string[] = []
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
  const recipientRegistration = recipientIds.length > 0
    ? await preflightRecipientRegistration(rpc, tokenContract, recipientIds)
    : undefined;

  return {
    tokenContract,
    decimals: metadata.decimals,
    senders,
    totalTokenBalance,
    totalRequired,
    enoughTokenBalance: totalTokenBalance >= totalRequired,
    ...(recipientRegistration ? { recipientRegistration } : {})
  };
}


async function preflightRecipientRegistration(
  rpc: NearRpcClient,
  tokenContract: string,
  recipientIds: readonly string[],
  concurrency = 8
): Promise<RecipientRegistrationPreflight> {
  const uniqueRecipients = [...new Set(recipientIds)];
  let registered = 0;
  let notRegistered = 0;
  let unsupported = 0;
  const sampleNotRegistered: string[] = [];

  for (let offset = 0; offset < uniqueRecipients.length; offset += concurrency) {
    const chunk = uniqueRecipients.slice(offset, offset + concurrency);
    const states = await Promise.all(
      chunk.map((accountId) =>
        getStorageRegistrationState(rpc, tokenContract, accountId)
      )
    );

    states.forEach((state, index) => {
      if (state === "registered") {
        registered += 1;
      } else if (state === "not-registered") {
        notRegistered += 1;
        if (sampleNotRegistered.length < 12) {
          sampleNotRegistered.push(chunk[index]);
        }
      } else {
        unsupported += 1;
      }
    });
  }

  return {
    checked: uniqueRecipients.length,
    registered,
    notRegistered,
    unsupported,
    sampleNotRegistered
  };
}
