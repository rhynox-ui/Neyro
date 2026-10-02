import { describe, expect, it } from "vitest";
import { allocateRecipientsDetailed, parseAmount, type ValidRecipient } from "./airdrop-core";

const recipient = (line: number, wallet: string, amountBase: bigint): ValidRecipient => ({
  line, wallet, amountBase
});

describe("airdrop core", () => {
  it("rejects impossible aggregate balance before allocation", () => {
    expect(() =>
      allocateRecipientsDetailed(
        [recipient(1, "a.near", 80n), recipient(2, "b.near", 80n)],
        [
          { senderId: "s1.near", tokenBalance: 100n, nativeBalance: 0n },
          { senderId: "s2.near", tokenBalance: 50n, nativeBalance: 0n }
        ]
      )
    ).toThrow("insufficient total sender token balance");
  });

  it("returns deterministic allocations and totals", () => {
    const allocations = allocateRecipientsDetailed(
      [
        recipient(1, "a.near", 60n),
        recipient(2, "b.near", 40n),
        recipient(3, "c.near", 20n)
      ],
      [
        { senderId: "s1.near", tokenBalance: 100n, nativeBalance: 10n },
        { senderId: "s2.near", tokenBalance: 50n, nativeBalance: 10n }
      ]
    );

    expect(allocations).toEqual([
      { senderId: "s1.near", recipients: [recipient(1, "a.near", 60n), recipient(2, "b.near", 40n)], totalAmount: 100n },
      { senderId: "s2.near", recipients: [recipient(3, "c.near", 20n)], totalAmount: 20n }
    ]);
  });

  it("rejects invalid decimals", () => {
    expect(() => parseAmount("1", -1)).toThrow();
    expect(() => parseAmount("1", 25)).toThrow();
  });
});
