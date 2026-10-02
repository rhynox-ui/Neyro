import { TOKEN_TOOL_FEE_RECIPIENT } from "./fee-recipient";

/**
 * Sponsorship is intentionally separate from fee collection.
 *
 * The current Neyro configuration proves that TOKEN_TOOL_FEE_RECIPIENT is the
 * treasury, but does not define a web gas-relayer credential or sponsorship
 * service. Therefore this module exposes the policy without pretending that
 * the treasury can sign on behalf of a browser wallet.
 */
export type SponsorshipMode = "user-pays-gas" | "relayer";

export type SponsorshipPolicy = {
  mode: SponsorshipMode;
  feeTreasury: string;
  sponsorAccount?: string;
  provider?: string;
};

export const DEFAULT_SPONSORSHIP_POLICY: SponsorshipPolicy = {
  mode: "user-pays-gas",
  feeTreasury: TOKEN_TOOL_FEE_RECIPIENT
};

export function assertSponsorshipConfigured(policy: SponsorshipPolicy): void {
  if (policy.mode === "relayer" && (!policy.sponsorAccount || !policy.provider)) {
    throw new Error("Relayer sponsorship requires an explicit sponsor account and provider");
  }
}
