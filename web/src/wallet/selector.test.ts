import { describe, expect, it, vi } from "vitest";
import { WalletSelectorConnector } from "./selector";
import { WalletPopupBlockedError } from "./connector";

function fakeWallet(accounts: Array<{ accountId: string }> = []) {
  return {
    getAccounts: vi.fn(async () => accounts),
    signIn: vi.fn(async () => accounts),
    signOut: vi.fn(async () => {}),
    signAndSendTransaction: vi.fn(async () => ({
      transaction: { hash: "tx-hash" }
    })),
    signAndSendTransactions: vi.fn(async () => [
      { transaction: { hash: "first" } },
      undefined
    ])
  };
}

describe("WalletSelectorConnector", () => {
  it("connects an already signed-in account", async () => {
    const wallet = fakeWallet([{ accountId: "alice.near" }]);
    const connector = new WalletSelectorConnector({} as never, wallet as never);

    await expect(connector.connect()).resolves.toEqual({ accountId: "alice.near" });
    expect(wallet.signIn).not.toHaveBeenCalled();
  });

  it("signs only for a connected signer and preserves the transaction hash", async () => {
    const wallet = fakeWallet([{ accountId: "alice.near" }]);
    const connector = new WalletSelectorConnector({} as never, wallet as never);

    await expect(connector.signAndSend({
      signerId: "alice.near",
      receiverId: "token.near",
      actions: [{
        type: "FunctionCall",
        receiverId: "token.near",
        methodName: "ft_transfer",
        args: { receiver_id: "bob.near", amount: "1" },
        gas: 30_000_000_000_000n,
        deposit: 1n
      }]
    })).resolves.toEqual({ transactionHash: "tx-hash" });

    expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects an unconnected signer", async () => {
    const wallet = fakeWallet([{ accountId: "alice.near" }]);
    const connector = new WalletSelectorConnector({} as never, wallet as never);

    await expect(connector.signAndSend({
      signerId: "bob.near",
      receiverId: "token.near",
      actions: []
    })).rejects.toThrow("Signer account is not connected");
  });

  it("rejects mixed action receivers", async () => {
    const wallet = fakeWallet([{ accountId: "alice.near" }]);
    const connector = new WalletSelectorConnector({} as never, wallet as never);

    await expect(connector.signAndSend({
      signerId: "alice.near",
      receiverId: "token.near",
      actions: [{
        type: "Transfer",
        receiverId: "treasury.near",
        deposit: 1n
      }]
    })).rejects.toThrow("Every action receiver");
  });

  it("signs several transactions in one approval and keeps positional hashes", async () => {
    const wallet = fakeWallet([{ accountId: "alice.near" }]);
    const connector = new WalletSelectorConnector({} as never, wallet as never);

    await expect(connector.signAndSendMany([
      { signerId: "alice.near", receiverId: "a.near", actions: [{ type: "Transfer", receiverId: "a.near", deposit: 1n }] },
      { signerId: "alice.near", receiverId: "b.near", actions: [{ type: "Transfer", receiverId: "b.near", deposit: 1n }] }
    ])).resolves.toEqual([{ transactionHash: "first" }, { transactionHash: undefined }]);
    expect(wallet.signAndSendTransactions).toHaveBeenCalledTimes(1);
  });

  it("treats My NEAR Wallet's empty account entry as signed out and opens sign-in", async () => {
    const wallet = fakeWallet([{ accountId: "" }]);
    wallet.signIn = vi.fn(async () => [{ accountId: "alice.near" }]);
    const connector = new WalletSelectorConnector({} as never, wallet as never);

    await expect(connector.getAccounts()).resolves.toEqual([]);
    await expect(connector.connect()).resolves.toEqual({ accountId: "alice.near" });
    expect(wallet.signIn).toHaveBeenCalledTimes(1);
  });

  it("reports a blocked wallet pop-up as a typed not-signed error", async () => {
    const wallet = fakeWallet([{ accountId: "alice.near" }]);
    wallet.signAndSendTransaction = vi.fn(async () => {
      throw new Error("Popup window blocked. Please allow popups for this site.");
    });
    const connector = new WalletSelectorConnector({} as never, wallet as never);

    await expect(connector.signAndSend({
      signerId: "alice.near",
      receiverId: "a.near",
      actions: [{ type: "Transfer", receiverId: "a.near", deposit: 1n }]
    })).rejects.toBeInstanceOf(WalletPopupBlockedError);
  });
});
