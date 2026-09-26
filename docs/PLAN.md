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

## 3. Phase 2

- NEARly launch discovery
- Trending/new-token feed
- Token pages
- Price alerts
- Take-profit / stop-loss
- Limit orders

## 4. Phase 3

- Copy trading
- DCA
- Whale tracking
- Advanced analytics
- NEAR Intents / cross-chain execution

## 5. Architecture

Telegram UI
  -> Application API
  -> Trading Engine
  -> Wallet Service
  -> RHEA Adapter
  -> NEAR Adapter
  -> PostgreSQL / Redis
  -> NEAR mainnet

The trading engine must remain independent from Telegram so a web/mobile client can be added later.

## 6. First implementation order

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
- RHEA API client
- quote normalization
- swap transaction builder
- signer/executor
- transaction status
- trade persistence

### Milestone D — discovery
- NEARly integration
- token/pool index
- new-launch detection

## 7. Safety requirements

- Never log private keys or seed phrases.
- Never place a trade without an explicit user confirmation in MVP.
- Validate token identifiers before execution.
- Enforce maximum trade size and slippage.
- Treat a timeout as unknown status, not automatic failure.
- Keep RHEA API credentials server-side only.
