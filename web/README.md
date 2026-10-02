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

- CSV success/failure export.
- Verified contract-specific Mint/Burn/Lock/Unlock flows.
- Verified NEARly launch and trading flows.
- Verified Developer transaction-builder flows.
- Explicit relayer/sponsorship integration if a real sponsor account/provider is selected.

Every execution path must remain isolated from Telegram code and must use verified contract interfaces rather than mock/static protocol behavior.
