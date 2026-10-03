import { describe, expect, it } from "vitest";
import type { NearRpcClient } from "../near/rpc";
import {
  buildTokenArgs,
  buildTokenCreationTransactions,
  CREATE_TOKEN_GAS,
  parseSupply,
  quoteTokenCreation,
  tokenAccountId,
  validateTokenDraft,
  type TokenDraft
} from "./token-factory";

const draft: TokenDraft = {
  ownerId: "alice.near",
  name: "Neyro Test",
  symbol: "NTEST",
  decimals: 18,
  totalSupplyBase: parseSupply("1000000", 18)
};

describe("token factory adapter", () => {
  it("derives the factory sub-account from the lowercase symbol", () => {
    expect(tokenAccountId("NTEST", "tkn.near")).toBe("ntest.tkn.near");
  });

  it("builds the exact create_token args documented by the factory", () => {
    expect(buildTokenArgs(draft)).toEqual({
      owner_id: "alice.near",
      total_supply: "1000000000000000000000000",
      metadata: { spec: "ft-1.0.0", name: "Neyro Test", symbol: "NTEST", decimals: 18 }
    });
  });

  it("rejects symbols the factory would reject", () => {
    expect(validateTokenDraft({ ...draft, symbol: "N-TEST" }, "tkn.near"))
      .toContain("Symbol may contain only letters and digits.");
    expect(validateTokenDraft(draft, "tkn.near")).toEqual([]);
  });

  it("parses supply exactly and refuses excess precision", () => {
    expect(parseSupply("1.5", 2)).toBe(150n);
    expect(() => parseSupply("1.555", 2)).toThrow("more than 2 decimals");
  });

  it("orders the factory call before the 1 NEAR Mint fee", () => {
    const [create, fee] = buildTokenCreationTransactions(
      "alice.near", "tkn.near", buildTokenArgs(draft), 5n
    );
    expect(create.receiverId).toBe("tkn.near");
    expect(create.actions[0]).toMatchObject({
      type: "FunctionCall", methodName: "create_token", gas: CREATE_TOKEN_GAS, deposit: 5n
    });
    expect(fee).toMatchObject({ receiverId: "widekingdom6862.near" });
    expect(fee.actions[0]).toMatchObject({ type: "Transfer", deposit: 10n ** 24n });
  });

  it("quotes from the factory's live views and the signer's spendable balance", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const rpc = {
      viewFunction: async (contract: string, method: string, args: unknown) => {
        calls.push([contract, method, args]);
        return method === "get_required_deposit" ? "2000000000000000000000000" : null;
      },
      viewAccount: async () => ({ amount: "5000000000000000000000000", storage_usage: 1000 }),
      gasPrice: async () => 100_000_000n
    } as unknown as NearRpcClient;

    const quote = await quoteTokenCreation(rpc, "tkn.near", "alice.near", buildTokenArgs(draft));
    expect(calls.map(([, method]) => method)).toEqual(["get_required_deposit", "get_token"]);
    expect(calls[1][2]).toEqual({ token_id: "ntest" });
    expect(quote.symbolAvailable).toBe(true);
    expect(quote.storageDeposit).toBe(2n * 10n ** 24n);
    expect(quote.totalRequired).toBe(3n * 10n ** 24n + CREATE_TOKEN_GAS * 100_000_000n);
    expect(quote.availableBalance).toBe(5n * 10n ** 24n - 10n ** 22n);
    expect(quote.sufficientBalance).toBe(true);
  });
});
