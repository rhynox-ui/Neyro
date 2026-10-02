import { describe, expect, it } from "vitest";
import { campaignIdFromFingerprint } from "./storage";

describe("campaign persistence identifiers", () => {
  it("creates stable sha256 campaign ids", async () => {
    const first = await campaignIdFromFingerprint("token.near|sender.near|source-1");
    const second = await campaignIdFromFingerprint("token.near|sender.near|source-1");
    const different = await campaignIdFromFingerprint("token.near|sender.near|source-2");

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(first).not.toBe(different);
  });
});
