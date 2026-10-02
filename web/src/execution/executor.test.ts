import { describe, expect, it } from "vitest";
import type { Allocation } from "../airdrop-core";
import type { Campaign } from "../campaign/model";
import type { CampaignStore } from "../campaign/storage";
import type { NearRpcClient } from "../near/rpc";
import type { WebWalletConnector } from "../wallet/connector";
import { executeAirdrop, reconcileCampaign } from "./executor";

class MemoryStore implements CampaignStore {
  private campaigns = new Map<string, Campaign>();

  async get(id: string): Promise<Campaign | null> {
    return this.campaigns.get(id) ?? null;
  }

  async put(campaign: Campaign): Promise<void> {
    this.campaigns.set(campaign.id, structuredClone(campaign));
  }

  async delete(id: string): Promise<void> {
    this.campaigns.delete(id);
  }

  async list(): Promise<Campaign[]> {
    return [...this.campaigns.values()].map((campaign) => structuredClone(campaign));
  }
}

function rpcStub(): NearRpcClient {
  const rpc = {
    viewFunction: async <T>(_contract: string, method: string, args: unknown) => {
      if (method === "ft_balance_of") return "1000" as T;
      if (method === "storage_balance_of") return { total: "1" } as T;
      throw new Error(`unexpected view method: ${method} ${JSON.stringify(args)}`);
    },
    transactionStatus: async () => ({
      status: { SuccessValue: "" }
    })
  };
  return rpc as unknown as NearRpcClient;
}

const allocation: Allocation = {
  senderId: "sender.near",
  recipients: [
    { line: 1, wallet: "alice.near", amountBase: 100n },
    { line: 2, wallet: "bob.near", amountBase: 200n }
  ],
  totalAmount: 300n
};

function walletStub(
  signAndSend: WebWalletConnector["signAndSend"]
): WebWalletConnector {
  return {
    id: "test",
    connect: async () => ({ accountId: "sender.near" }),
    disconnect: async () => {},
    getAccounts: async () => [{ accountId: "sender.near" }],
    signAndSend
  };
}

describe("web airdrop execution", () => {
  it("signs each planned batch and waits for final success", async () => {
    const store = new MemoryStore();
    const hashes: string[] = [];
    const wallet = walletStub(async (request) => {
      hashes.push(request.actions[0]?.type === "FunctionCall"
        ? String(request.actions[0].args.amount)
        : "not-function-call");
      return { transactionHash: `tx-${hashes.length}` };
    });

    const result = await executeAirdrop({
      tokenContract: "token.near",
      decimals: 0,
      allocations: [allocation],
      sourceFingerprint: "source-1",
      wallet,
      rpc: rpcStub(),
      store,
      maxActions: 1
    });

    expect(hashes).toEqual(["100", "200"]);
    expect(result.campaign.status).toBe("completed");
    expect(result.campaign.batches.every((batch) => batch.status === "success")).toBe(true);
  });

  it("reconciles a submitted transaction after an RPC outcome interruption", async () => {
    const store = new MemoryStore();
    let statusReads = 0;
    const rpc = rpcStub();
    const originalStatus = rpc.transactionStatus;
    rpc.transactionStatus = async (hash: string, senderId: string) => {
      statusReads += 1;
      if (statusReads === 1) throw new Error("temporary RPC failure");
      return originalStatus(hash, senderId);
    };

    const wallet = walletStub(async () => ({ transactionHash: "tx-reconcile" }));

    await expect(
      executeAirdrop({
        tokenContract: "token.near",
        decimals: 0,
        allocations: [allocation],
        sourceFingerprint: "source-reconcile",
        wallet,
        rpc,
        store,
        maxActions: 1
      })
    ).rejects.toThrow("temporary RPC failure");

    const campaigns = await store.list();
    expect(campaigns[0].batches[0].status).toBe("unknown");

    const reconciled = await reconcileCampaign(campaigns[0].id, store, rpc);
    expect(reconciled.batches[0].status).toBe("success");
  });

  it("marks wallet execution as unknown instead of blindly retrying", async () => {
    const store = new MemoryStore();
    const wallet = walletStub(async () => {
      throw new Error("wallet response interrupted");
    });

    await expect(
      executeAirdrop({
        tokenContract: "token.near",
        decimals: 0,
        allocations: [allocation],
        sourceFingerprint: "source-2",
        wallet,
        rpc: rpcStub(),
        store,
        maxActions: 1
      })
    ).rejects.toThrow("wallet response interrupted");

    const campaigns = await store.list();
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].status).toBe("paused");
    expect(campaigns[0].batches[0].status).toBe("unknown");
  });
});
