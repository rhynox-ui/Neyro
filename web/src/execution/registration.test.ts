import { describe, expect, it } from "vitest";
import type { RegistrationStore } from "../campaign/storage";
import type { NearRpcClient } from "../near/rpc";
import type { WebWalletConnector } from "../wallet/connector";
import {
  executeRecipientRegistration,
  reconcileRecipientRegistration,
  type RegistrationSession
} from "./registration";
import { testLocks } from "./test-support";

class MemoryRegistrations implements RegistrationStore {
  private sessions = new Map<string, RegistrationSession>();
  async getRegistration(id: string) { return structuredClone(this.sessions.get(id) ?? null); }
  async putRegistration(session: RegistrationSession) { this.sessions.set(session.id, structuredClone(session)); }
  async deleteRegistration(id: string) { this.sessions.delete(id); }
  async listRegistrations() { return [...this.sessions.values()].map((s) => structuredClone(s)); }
}

function rpcStub(registered: Set<string>): NearRpcClient {
  return {
    viewFunction: async <T>(_contract: string, method: string, args: { account_id?: string }) => {
      if (method === "storage_balance_bounds") return { min: "1250000000000000000000", max: null } as T;
      if (method === "storage_balance_of") {
        return (registered.has(args.account_id ?? "") ? { total: "1250000000000000000000", available: "0" } : null) as T;
      }
      throw new Error(`unexpected ${method}`);
    },
    viewAccount: async () => ({ amount: "100000000000000000000000000", storage_usage: 0 }),
    gasPrice: async () => 100_000_000n,
    transactionStatus: async () => ({ status: { SuccessValue: "" } })
  } as unknown as NearRpcClient;
}

function wallet(signAndSend: WebWalletConnector["signAndSend"]): WebWalletConnector {
  return {
    id: "test",
    connect: async () => ({ accountId: "payer.near" }),
    disconnect: async () => {},
    getAccounts: async () => [{ accountId: "payer.near" }],
    signAndSend,
    signAndSendMany: async () => { throw new Error("unused"); }
  };
}

const base = { tokenContract: "token.near", payerId: "payer.near", recipientIds: ["a.near", "b.near"] };

async function hashlessUnknown(store: MemoryRegistrations, registered: Set<string>) {
  const rpc = rpcStub(registered);
  await expect(executeRecipientRegistration({
    ...base, rpc, store, locks: testLocks(),
    wallet: wallet(async () => { throw new Error("User closed the window"); })
  })).rejects.toThrow("User closed the window");
  const [session] = await store.listRegistrations();
  expect(session.batches[0].status).toBe("unknown");
  expect(session.batches[0].transactionHash).toBeUndefined();
  return { session, rpc };
}

describe("recipient registration recovery", () => {
  it("resolves a hashless batch as success when every recipient is registered on-chain", async () => {
    const store = new MemoryRegistrations();
    const registered = new Set<string>();
    const { session, rpc } = await hashlessUnknown(store, registered);

    registered.add("a.near");
    registered.add("b.near");
    const reconciled = await reconcileRecipientRegistration(session.id, store, rpc, testLocks());
    expect(reconciled.batches[0].status).toBe("success");
    expect(reconciled.status).toBe("completed");
  });

  it("marks a hashless batch failed when recipients are still unregistered, and the retry signs again", async () => {
    const store = new MemoryRegistrations();
    const registered = new Set(["a.near"]);
    const { session, rpc } = await hashlessUnknown(store, registered);

    const reconciled = await reconcileRecipientRegistration(session.id, store, rpc, testLocks());
    expect(reconciled.batches[0].status).toBe("failed");
    expect(reconciled.batches[0].error).toContain("1 of 2 recipients are not registered");

    let signed = 0;
    const retried = await executeRecipientRegistration({
      ...base, rpc, store, locks: testLocks(),
      wallet: wallet(async () => { signed += 1; return { transactionHash: "retry-hash" }; })
    });
    expect(signed).toBe(1);
    expect(retried.batches[0].status).toBe("success");
    expect(retried.batches[0].transactionHash).toBe("retry-hash");
  });

  it("turns an interrupted signing batch into a chain-checked result", async () => {
    const store = new MemoryRegistrations();
    const registered = new Set<string>();
    const { session, rpc } = await hashlessUnknown(store, registered);
    session.batches[0] = { ...session.batches[0], status: "signing", error: undefined };
    await store.putRegistration(session);

    registered.add("a.near");
    registered.add("b.near");
    const reconciled = await reconcileRecipientRegistration(session.id, store, rpc, testLocks());
    expect(reconciled.batches[0].status).toBe("success");
  });
});
