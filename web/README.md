# Neyro Web Terminal

This is a separate web application inside the Neyro repository.

## Isolation rule

Do not import Telegram handlers, Telegram state, encrypted signer storage, Telegram wallet services,
or the Worker entrypoint into this app.

The web terminal is non-custodial. Browser wallet signing is isolated in the web execution layer;
the existing Telegram custody architecture remains untouched.

## Current foundation

- NEAR mainnet-oriented terminal shell
- Bulk airdrop UI
- Streaming CSV/TXT parsing for large files
- JSON support for smaller recipient files
- NEAR account validation
- Duplicate detection
- BigInt base-unit totals
- 100-recipient batch planning
- Multi-sender account pool input

For million-wallet campaigns, CSV/TXT is preferred because the browser can process the file as a
stream instead of parsing a giant JSON object tree.

## Execution layer currently wired

1. Browser wallet connection using NEAR Wallet Selector/My Near Wallet.
2. Token metadata, sender balance and storage-registration checks.
3. Deterministic multi-sender allocation.
4. Conservative gas-aware batch construction.
5. IndexedDB campaign state with exact recipient amounts.
6. Per-batch signing/submission/finality state.
7. Unknown/submitted transaction reconciliation without blind retries.
8. Fresh token/native balance and gas-price checks before every batch.

## Still to build

- Verified generic Mint deployment through a Neyro token factory/implementation.
- Verified contract-specific Lock/Unlock execution.
- In-terminal recipient registration execution using the token's verified NEP-145 storage bounds (implemented; real-wallet verification remains).
- Production-scale memory-bounded planning for large airdrops.
- Verified liquidity creation/management flows.
- Verified trade execution and Developer transaction-builder flows.
- Explicit relayer/sponsorship integration if a real sponsor account/provider is selected.

Every execution path must remain isolated from Telegram code and must use verified contract interfaces rather than mock/static protocol behavior.


## Audit status — 2026-10-02

The web terminal CI is passing on the current branch (Web Terminal CI #357 and repository CI #577 for the latest audit checkpoint). The production Pages build is configured from this branch and the stable project subdomain remains unchanged.

The current product surface is intentionally non-custodial, but generic Mint execution is still gated until the token factory/implementation is deployed and its exact interface is verified. Tax, freeze, metadata and mint-authority controls are therefore configuration-only until that implementation exists.

Bulk transfer execution is wired and safety-tested. Recipient NEP-145 registration is now checked before execution and unregistered/unknown recipients are blocked. In-terminal registration itself and million-wallet memory-bounded planning remain release gates.

## 2026-10-02 — Recipient registration execution

The bulk-transfer UI performs a bounded-concurrency NEP-145 registration preflight before signing. Unregistered recipients and tokens whose storage API cannot be verified are blocked. Registration uses the token-reported storage minimum, the connected browser wallet pays the storage deposit, registration sessions are persisted in IndexedDB, and unknown/submitted transactions require reconciliation before retry.
