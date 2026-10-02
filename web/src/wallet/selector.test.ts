import { describe, expect, it, vi } from "vitest";
import { WalletSelectorConnector } from "./selector";

function fakeWallet(accounts: Array<{ accountId: string }> = []) {
  return {
    getAccounts: vi.fn(async () => accounts),
    signIn: vi.fn(async () => accounts),
    signOut: vi.fn(async () => {}),
    signAndSendTransaction: vi.fn(async () => ({
      transaction: { hash: "tx-hash" }
    }))
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
});
