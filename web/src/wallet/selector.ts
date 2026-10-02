import {
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
      accounts = await this.wallet.signIn({});
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

  async signAndSend(request: SignAndSendRequest) {
    const accounts = await this.getAccounts();
    if (!accounts.some((account) => account.accountId === request.signerId)) {
      throw new Error("Signer account is not connected to the browser wallet");
    }

    for (const action of request.actions) {
      if (action.receiverId !== request.receiverId) {
        throw new Error("Every action receiver must match the transaction receiver");
      }
    }

    const actions = request.actions.map((action) => {
      if (action.type === "FunctionCall") {
        return {
          type: "FunctionCall" as const,
          params: {
            methodName: action.methodName,
            args: action.args,
            gas: action.gas.toString(),
            deposit: action.deposit.toString()
          }
        };
      }

      return {
        type: "Transfer" as const,
        params: {
          deposit: action.deposit.toString()
        }
      };
    });

    const outcome = await this.wallet.signAndSendTransaction({
      signerId: request.signerId,
      receiverId: request.receiverId,
      actions
    }) as ExecutionOutcome | void;

    return {
      transactionHash: outcome?.transaction?.hash
    };
  }
}

export async function createMyNearWalletConnector(): Promise<WalletSelectorConnector> {
  const selector = await setupWalletSelector({
    network: "mainnet",
    modules: [setupMyNearWallet()]
  });
  return new WalletSelectorConnector(selector, selector.wallet(WALLET_ID));
}
