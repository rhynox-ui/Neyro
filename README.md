# Neyro

NEAR-native Telegram trading terminal.

## Status

Early foundation. The first milestone is NEAR spot trading through RHEA, followed by NEARly token discovery.

## Architecture

Telegram -> Bot/Application -> Trading Engine -> NEAR/RHEA

### Planned modules

- Telegram UX and command handlers
- NEAR wallet/account management
- RHEA quote and swap adapter
- NEARly token discovery/indexing
- Portfolio and transaction tracking
- Risk controls and encrypted signer storage

## Protocol fee

Neyro charges 1% of each trade, capped at $60, inside the swap transaction.
Fees go to the team wallet `widekingdom6862.near`, set with
`TREASURY_ACCOUNT_ID` (see `.env.example`). Fees are off when it is unset.

## Security

Never commit Telegram bot tokens, RHEA API tokens, seed phrases, private keys, or production credentials.

## Development

Node.js + TypeScript.

See `docs/PLAN.md` for the product and implementation roadmap.
