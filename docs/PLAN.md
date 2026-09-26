# Neyro — Product & Technical Plan

## 1. Product

Neyro is a Telegram-first NEAR trading terminal. The initial product focuses on fast NEAR-native spot trading with RHEA liquidity and NEARly token discovery.

## 2. MVP

1. Telegram bot bootstrap
2. User/session database
3. NEAR account/wallet creation and encrypted signer boundary
4. NEAR balance and token balance
5. Token resolution
6. RHEA quote
7. Buy and sell execution
8. Transaction confirmation
9. Portfolio and trade history
10. Basic slippage/risk controls

## 3. Current implementation

- TypeScript/Node.js application
- Grammy Telegram layer
- NEAR RPC client
- RHEA unified Swap SDK 2.x
- Live NEAR token-list boundary
- Normalized RHEA quote model
- Secure signer interface with no private-key exposure to bot handlers
- Initial PostgreSQL schema
- GitHub Actions typecheck

RHEA's current SDK supports NEAR execution through a dedicated executor and exposes quote -> build -> execute flow. Neyro intentionally stops before signing until the production signer vault is implemented.

## 4. Phase 2

- NEARly launch discovery
- Trending/new-token feed
- Token pages
- Price alerts
- Take-profit / stop-loss
- Limit orders

## 5. Phase 3

- Copy trading
- DCA
- Whale tracking
- Advanced analytics
- NEAR Intents / cross-chain execution

## 6. Architecture

Telegram UI
  -> Application API
  -> Trading Engine
  -> Wallet Service
  -> RHEA Adapter
  -> NEAR Adapter
  -> PostgreSQL / Redis
  -> NEAR mainnet

The trading engine must remain independent from Telegram so a web/mobile client can be added later.

## 7. First implementation order

### Milestone A — foundation
- TypeScript project
- configuration validation
- structured logging
- Telegram bot skeleton
- NEAR RPC client
- health check

### Milestone B — wallet
- create NEAR account strategy
- signer abstraction
- encrypted key storage interface
- balance queries
- deposit/withdraw flow

### Milestone C — trading
- RHEA SDK
- quote normalization
- swap build
- secure NEAR executor
- transaction status
- trade persistence

### Milestone D — discovery
- NEARly integration
- token/pool index
- new-launch detection

## 8. Safety requirements

- Never log private keys or seed phrases.
- Never place a trade without an explicit user confirmation in MVP.
- Validate token identifiers before execution.
- Enforce maximum trade size and slippage.
- Treat a timeout as unknown status, not automatic failure.
- Keep RHEA API credentials server-side only.
- Never modify RHEA's normalized quote/build context before execution.

## 9. Reference

RHEA unified Swap SDK:
https://github.com/rhea-finance/crossChain-aggregation-sdk

RHEA API documentation:
https://github.com/rhea-finance/rhea-sdk-docs/blob/main/CrossChainDexAPI.md
