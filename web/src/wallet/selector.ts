import {
  actionCreators,
  setupWalletSelector,
  type Wallet,
  type WalletSelector
} from "@near-wallet-selector/core";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import type {
  SignAndSendRequest,
  WebWalletConnector
} from "./connector";

const WALLET_ID = "my-near-wallet";

type ExecutionOutcome = {
  transaction?: {
    hash?: string;
  };
};

export class WalletSelectorConnector implements WebWalletConnector {
  readonly id = WALLET_ID;

  constructor(
    private readonly selector: WalletSelector,
    private readonly wallet: Wallet
  ) {}

  async connect() {
    let accounts = await this.wallet.getAccounts();
    if (accounts.length === 0) {
      // Wallet Selector v10's core type intersects hardware-wallet params with
      // browser-wallet params. MyNearWallet does not require a contractId.
      accounts = await this.wallet.signIn({ accounts: [] } as never);
    }
    const account = accounts[0];
    if (!account?.accountId) {
      throw new Error("No NEAR account was returned by the browser wallet");
    }
    return { accountId: account.accountId };
  }

  async disconnect(): Promise<void> {
    await this.wallet.signOut();
  }

  async getAccounts() {
    return (await this.wallet.getAccounts()).map((account) => ({
      accountId: account.accountId
    }));
  }

  private async assertSignable(request: SignAndSendRequest): Promise<void> {
    const accounts = await this.getAccounts();
    if (!accounts.some((account) => account.accountId === request.signerId)) {
      throw new Error("Signer account is not connected to the browser wallet");
    }
    for (const action of request.actions) {
      if (action.receiverId !== request.receiverId) {
        throw new Error("Every action receiver must match the transaction receiver");
      }
    }
  }

  private toSelectorTransaction(request: SignAndSendRequest) {
    return {
      signerId: request.signerId,
      receiverId: request.receiverId,
      actions: request.actions.map((action) =>
        action.type === "FunctionCall"
          ? actionCreators.functionCall(action.methodName, action.args, action.gas, action.deposit)
          : actionCreators.transfer(action.deposit)
      )
    };
  }

  async signAndSend(request: SignAndSendRequest) {
    await this.assertSignable(request);
    const outcome = await this.wallet.signAndSendTransaction(
      this.toSelectorTransaction(request)
    ) as ExecutionOutcome | void;

    return {
      transactionHash: outcome?.transaction?.hash
    };
  }

  async signAndSendMany(requests: SignAndSendRequest[]) {
    if (requests.length === 0) throw new Error("No transactions to sign");
    for (const request of requests) await this.assertSignable(request);
    const outcomes = await this.wallet.signAndSendTransactions({
      transactions: requests.map((request) => this.toSelectorTransaction(request))
    }) as Array<ExecutionOutcome | undefined> | void;

    return requests.map((_, index) => ({
      transactionHash: outcomes?.[index]?.transaction?.hash
    }));
  }
}

export async function createMyNearWalletConnector(): Promise<WalletSelectorConnector> {
  const selector = await setupWalletSelector({
    network: "mainnet",
    modules: [setupMyNearWallet()]
  });
  const wallet = await selector.wallet(WALLET_ID);
  return new WalletSelectorConnector(selector, wallet);
}
