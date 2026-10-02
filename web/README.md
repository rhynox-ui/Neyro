# Neyro Web Terminal

This is a separate web application inside the Neyro repository.

## Isolation rule

Do not import Telegram handlers, Telegram state, encrypted signer storage, Telegram wallet services,
or the Worker entrypoint into this app.

The web terminal is non-custodial. Browser wallet signing will be implemented in the web execution
layer; the existing Telegram custody architecture remains untouched.

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

## Execution layer still to build

1. Browser wallet connection using current NEAR Wallet Selector.
2. Token metadata, sender balance and storage-registration checks.
3. Deterministic multi-sender allocation.
4. Gas-aware batch construction.
5. Persistent campaign state and resumable execution.
6. Per-batch transaction tracking and safe retries.
7. Exportable success/failure report.

Every batch must revalidate token, recipients, amounts, sender and balances before signing.
