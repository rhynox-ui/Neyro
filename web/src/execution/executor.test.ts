import { describe, expect, it } from "vitest";
import type { Allocation } from "../airdrop-core";
import type { Campaign } from "../campaign/model";
import type { CampaignStore } from "../campaign/storage";
import type { NearRpcClient } from "../near/rpc";
import type { WebWalletConnector } from "../wallet/connector";
import { attachTransactionHash, executeAirdrop, reconcileCampaign } from "./executor";
import { testLocks } from "./test-support";

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
    viewAccount: async () => ({
      amount: "1000000000000000000000000"
    }),
    gasPrice: async () => 100000000n,
    viewAccessKeyList: async () => ({
      keys: [{ public_key: "ed25519:key", access_key: { nonce: 5, permission: "FullAccess" } }],
      block_height: 1000,
      block_hash: "block"
    }),
    transactionValidityPeriod: async () => 100,
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
      maxActions: 1,
      locks: testLocks()
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
        maxActions: 1,
        locks: testLocks()
      })
    ).rejects.toThrow("temporary RPC failure");

    const campaigns = await store.list();
    expect(campaigns[0].batches[0].status).toBe("unknown");

    const reconciled = await reconcileCampaign(campaigns[0].id, store, rpc, undefined, testLocks());
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
        maxActions: 1,
        locks: testLocks()
      })
    ).rejects.toThrow("wallet response interrupted");

    const campaigns = await store.list();
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].status).toBe("paused");
    expect(campaigns[0].batches[0].status).toBe("unknown");
  });

  async function hashlessUnknownCampaign(rpc: NearRpcClient, store: MemoryStore, source: string) {
    const wallet = walletStub(async () => {
      throw new Error("User closed the window");
    });
    await expect(
      executeAirdrop({
        tokenContract: "token.near",
        decimals: 0,
        allocations: [allocation],
        sourceFingerprint: source,
        wallet,
        rpc,
        store,
        maxActions: 1,
        locks: testLocks()
      })
    ).rejects.toThrow("User closed the window");
    const [campaign] = await store.list();
    expect(campaign.batches[0].status).toBe("unknown");
    expect(campaign.batches[0].transactionHash).toBeUndefined();
    expect(campaign.batches[0].signingEvidence).toEqual({
      capturedAtBlockHeight: 1000,
      accessKeyNonces: { "ed25519:key": "5" }
    });
    return campaign;
  }

  function withChainState(rpc: NearRpcClient, nonce: number, height: number) {
    rpc.viewAccessKeyList = async () => ({
      keys: [{ public_key: "ed25519:key", access_key: { nonce, permission: "FullAccess" } }],
      block_height: height,
      block_hash: "block"
    });
  }

  it("keeps a hashless batch unknown while its signing window is still open", async () => {
    const store = new MemoryStore();
    const rpc = rpcStub();
    const campaign = await hashlessUnknownCampaign(rpc, store, "source-window");

    withChainState(rpc, 5, 1500);
    const reconciled = await reconcileCampaign(campaign.id, store, rpc, undefined, testLocks());
    expect(reconciled.batches[0].status).toBe("unknown");
    expect(reconciled.batches[0].error).toContain("could still be accepted");
  });

  it("keeps a hashless batch unknown when the sender nonce advanced", async () => {
    const store = new MemoryStore();
    const rpc = rpcStub();
    const campaign = await hashlessUnknownCampaign(rpc, store, "source-nonce");

    withChainState(rpc, 6, 999_999);
    const reconciled = await reconcileCampaign(campaign.id, store, rpc, undefined, testLocks());
    expect(reconciled.batches[0].status).toBe("unknown");
    expect(reconciled.batches[0].error).toContain("supply this batch's transaction hash");
  });

  it("marks a hashless batch failed only after non-execution is proven, then retries it", async () => {
    const store = new MemoryStore();
    const rpc = rpcStub();
    const campaign = await hashlessUnknownCampaign(rpc, store, "source-proven");

    // validity 100 + margin 1000 beyond capture height 1000, nonce unchanged.
    withChainState(rpc, 5, 2101);
    const reconciled = await reconcileCampaign(campaign.id, store, rpc, undefined, testLocks());
    expect(reconciled.batches[0].status).toBe("failed");
    expect(reconciled.batches[0].error).toContain("Proven not executed");

    const signed: string[] = [];
    const result = await executeAirdrop({
      tokenContract: "token.near",
      decimals: 0,
      allocations: [allocation],
      sourceFingerprint: "source-proven",
      wallet: walletStub(async (request) => {
        signed.push(String((request.actions[0] as { args: Record<string, unknown> }).args.receiver_id));
        return { transactionHash: `retry-${signed.length}` };
      }),
      rpc,
      store,
      maxActions: 1,
      locks: testLocks()
    });
    expect(signed).toEqual(["alice.near", "bob.near"]);
    expect(result.campaign.status).toBe("completed");
  });

  it("turns an interrupted signing batch into unknown during reconciliation", async () => {
    const store = new MemoryStore();
    const rpc = rpcStub();
    const campaign = await hashlessUnknownCampaign(rpc, store, "source-signing");
    campaign.batches[0] = { ...campaign.batches[0], status: "signing", error: undefined };
    await store.put(campaign);

    await expect(
      executeAirdrop({
        tokenContract: "token.near",
        decimals: 0,
        allocations: [allocation],
        sourceFingerprint: "source-signing",
        wallet: walletStub(async () => ({ transactionHash: "never" })),
        rpc,
        store,
        maxActions: 1,
        locks: testLocks()
      })
    ).rejects.toThrow("needs reconciliation");

    const reconciled = await reconcileCampaign(campaign.id, store, rpc, undefined, testLocks());
    expect(reconciled.batches[0].status).toBe("unknown");
  });

  const HASH = "4wBzPq6nJd8XoVnUGb3wkMf9ZQ3o2Cx2nEJnSjYGGW8T";

  function onChainTransaction(receiverId: string, amount: string, status: unknown = { SuccessValue: "" }) {
    return {
      status,
      transaction: {
        signer_id: "sender.near",
        receiver_id: "token.near",
        actions: [{
          FunctionCall: {
            method_name: "ft_transfer",
            args: btoa(JSON.stringify({ receiver_id: receiverId, amount })),
            gas: 30000000000000,
            deposit: "1"
          }
        }]
      }
    };
  }

  it("binds a user-supplied hash only when the transaction matches the batch", async () => {
    const store = new MemoryStore();
    const rpc = rpcStub();
    const campaign = await hashlessUnknownCampaign(rpc, store, "source-attach");
    const batchId = campaign.batches[0].id;

    rpc.transactionStatus = async () => onChainTransaction("alice.near", "999");
    await expect(
      attachTransactionHash(campaign.id, batchId, HASH, store, rpc, testLocks())
    ).rejects.toThrow("does not transfer 100 to alice.near");
    expect((await store.get(campaign.id))!.batches[0].status).toBe("unknown");

    rpc.transactionStatus = async () => onChainTransaction("alice.near", "100");
    const updated = await attachTransactionHash(campaign.id, batchId, HASH, store, rpc, testLocks());
    expect(updated.batches[0].status).toBe("success");
    expect(updated.batches[0].transactionHash).toBe(HASH);
  });

  it("records a matching but failed user-supplied hash as a retryable failure", async () => {
    const store = new MemoryStore();
    const rpc = rpcStub();
    const campaign = await hashlessUnknownCampaign(rpc, store, "source-attach-failed");

    rpc.transactionStatus = async () =>
      onChainTransaction("alice.near", "100", { Failure: { ActionError: {} } });
    const updated = await attachTransactionHash(
      campaign.id, campaign.batches[0].id, HASH, store, rpc, testLocks()
    );
    expect(updated.batches[0].status).toBe("failed");
  });

  it("refuses to run when the campaign is locked by another tab", async () => {
    const store = new MemoryStore();
    const locks = testLocks();
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = executeAirdrop({
      tokenContract: "token.near",
      decimals: 0,
      allocations: [allocation],
      sourceFingerprint: "source-lock",
      wallet: walletStub(async () => {
        await blocked;
        return { transactionHash: "tx-lock" };
      }),
      rpc: rpcStub(),
      store,
      maxActions: 1,
      locks
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      executeAirdrop({
        tokenContract: "token.near",
        decimals: 0,
        allocations: [allocation],
        sourceFingerprint: "source-lock",
        wallet: walletStub(async () => ({ transactionHash: "tx-second" })),
        rpc: rpcStub(),
        store,
        maxActions: 1,
        locks
      })
    ).rejects.toThrow("another tab");

    release();
    await expect(first).resolves.toBeDefined();
  });
});
