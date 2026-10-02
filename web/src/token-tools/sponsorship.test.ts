import { describe, expect, it } from "vitest";
import {
  assertSponsorshipConfigured,
  DEFAULT_SPONSORSHIP_POLICY
} from "./sponsorship";

describe("token tool sponsorship policy", () => {
  it("keeps fee treasury separate from gas sponsorship", () => {
    expect(DEFAULT_SPONSORSHIP_POLICY.mode).toBe("user-pays-gas");
    expect(DEFAULT_SPONSORSHIP_POLICY.feeTreasury).toBe("widekingdom6862.near");
  });

  it("rejects an incomplete relayer configuration", () => {
    expect(() =>
      assertSponsorshipConfigured({
        mode: "relayer",
        feeTreasury: "widekingdom6862.near"
      })
    ).toThrow(/sponsor account and provider/);
  });

  it("accepts an explicit relayer configuration", () => {
    expect(() =>
      assertSponsorshipConfigured({
        mode: "relayer",
        feeTreasury: "widekingdom6862.near",
        sponsorAccount: "sponsor.near",
        provider: "configured-relayer"
      })
    ).not.toThrow();
  });
});
