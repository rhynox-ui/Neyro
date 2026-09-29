# Neyro — Architecture Review (2026-09-26)

Scope: the full `src/` tree, `docs/`, CI, and the installed dependencies
(`near-api-js@7.3.1`, `@rhea-finance/cross-chain-aggregation-dex@2.1.5`,
`grammy@1.46`). It covers the current state, the defects found, how Neyro
compares with the NEAR ecosystem, and a recommended target architecture.

---

## 1. What exists today

```
Telegram (grammY, long polling)
  └─ bot/register.ts            commands + callbacks; module-level singletons
       ├─ WalletService         implicit account per Telegram user, AES-256-GCM key in Postgres/in-memory
       ├─ TradingService        prepare → in-memory pending map → execute
       │    └─ RheaTradingEngine ─ RheaClient (SwapClient) ─ NearExecutor ─ NearAccountSigner(Account+key)
       ├─ PortfolioService      ft_balance_of over every RHEA-listed token (not wired to UI)
       └─ near/rpc.ts           hand-rolled primary→fallback loop
Storage: Neon serverless Postgres (users, wallets, wallet_secrets, trades, …)
```

The layering intent (engine independent of Telegram, signer behind an
interface, quote kept immutable) is sound. Most issues are in execution
correctness, NEAR-specific details, and state that only lives in process memory.

## 2. Build status: CI is red

| Check | Result | Cause |
|---|---|---|
| `npm run typecheck` | **fails** | `src/portfolio/service.ts:27`: near-api-js 7 `Provider.callFunction` takes `method`, not `methodName`. Line 38: a leftover `return raw;` references an undefined variable. |
| `npm test` | **1/8 fails** | `test/rpc.test.ts` expects a `fallback` endpoint, but `RPC_ENDPOINTS` is built at import time from env and the test never sets `NEAR_RPC_FALLBACK_URL`. |

## 3. Defects, ranked by impact

### Critical: money or correctness

1. **A trade is reported "confirmed" even when the swap did not execute.**
   `NearAccountSigner.waitForTransactions` always returns `confirmed`. near-api-js
   throws only on a top-level failure. A NEAR swap is usually
   `ft_transfer_call → DEX → ft_resolve_transfer`. When the inner swap fails
   (slippage, pool moved), the tokens are **refunded and the transaction still
   succeeds**. RHEA's SDK docs place this check on the adapter: *"The adapter is
   responsible for interpreting … NEAR final execution status."*
   → Inspect every `receipts_outcome` for `Failure`, and check the
   `ft_resolve_transfer` return value or the token-out balance delta before
   reporting a fill.

2. **A timeout is recorded as `failed`.** `TradingService.execute` catches every
   error and writes `failed`. This breaks PLAN §8 ("treat a timeout as unknown
   status"). If a tx was broadcast and the RPC timed out, the user may retry and
   **double-buy**.
   → Add an `unknown` status and a reconciler that polls
   `EXPERIMENTAL_tx_status` by hash (record the signed tx hash *before* sending).

3. **A multi-transaction batch is not atomic.** RHEA NEAR builds can contain
   several transactions (for example `storage_deposit` and then the swap). If the
   first succeeds and a later one throws, there is no record of the partial
   state.
   → Persist each hash as it lands (`trade_events`) and resume or flag it.

4. **The network configuration contradicts itself.** The default is
   `NEAR_NETWORK=testnet`, with testnet RPCs and implicit testnet accounts. RHEA's
   API is **mainnet-only** (`wrap.near`, chain `900001`), and `trading/service.ts`
   hardcodes `wrap.near`. On testnet every quote is for mainnet tokens that the
   testnet account cannot hold.
   → Tie RHEA and trading to `mainnet`, and disable `/buy` and `/sell` on
   testnet (or use a mock engine there).

5. **Portfolio balances are always empty (latent bug).** Once the typecheck is
   fixed, `provider.callFunction` already JSON-parses the result, so
   `ft_balance_of` returns `"123"` as a JS string. `decodeJsonString` then calls
   `JSON.parse("123")`, gets a number, and throws. `Promise.allSettled` swallows
   the error, so every token is dropped silently.

### High: security

6. **One master key decrypts every wallet, and ciphertexts are not bound to rows.**
   AES-GCM has no AAD. Anyone who can write to the DB can swap `wallet_secrets`
   rows between users, and the victim's trades are then signed with the
   attacker's key, or the reverse.
   → Use `accountId` (plus `wallet_id`) as AAD. Move to envelope encryption: a
   per-wallet DEK wrapped by a KMS key. Plan for key rotation (`cipher_version`
   already exists).

7. **Decrypted keys live inside the bot process.** `getSigningAccount` builds an
   `Account` with the plaintext key in the same process that parses untrusted
   Telegram input. `SignerVault` and `UnconfiguredSignerVault` exist but are
   unused.
   → Split signing into its own service (see §5). The bot/API should only ever
   send *unsigned tx intents plus a trade id* to the signer.

8. **Implicit accounts get full-access keys.** A leaked key drains everything.
   → After funding, consider adding a function-call-only access key scoped to
   the DEX/router contracts for hot trading, and keep the full-access key cold
   (used for withdrawals only). NEAR's access-key model is a real advantage here
   that EVM/Solana bots don't have.

9. **There are no per-user limits or rate limits.** There is no per-user mutex
   around execute (a double tap is handled only by the in-process
   `pending.delete`). There are no daily caps, and the bot does not refuse to run
   in group chats.

### Medium: reliability and UX

10. **All state is in memory.** Pending quotes (`Map`), the portfolio cache, and
    the in-memory wallet repo when there is no `DATABASE_URL` are all lost on
    restart (a user's funded wallet key would be **lost** in that last case).
    The bot also can't run more than one replica.
    → Refuse to start the wallet service without a DB on mainnet. Put pending
    quotes in Postgres or Redis with a TTL.
11. **Quote TTL is hardcoded to 2 minutes.** The RHEA SDK exposes
    `quote.expiresAt`, so use it. Also re-check balance and slippage at
    confirmation time.
12. **The RPC failover duplicates a library feature.** near-api-js 7 ships
    `FailoverRpcProvider` with backoff. Also, `createNearConnection()` (used for
    signing and `/health`) bypasses the custom fallback entirely.
13. **Gas and storage reserve.** The buy check compares the amount with the
    total balance and ignores the ~0.00182 NEAR storage staking per 182 bytes,
    the gas, and `storage_deposit` for new FT contracts (~0.00125 NEAR each).
    Keep a fixed reserve (for example 0.05 NEAR) and use
    `viewAccount.amount − locked − storage`.
14. **A new implicit account does not exist on-chain until funded.**
    `/wallet` for an unfunded wallet calls `getNearBalance`, which throws; the
    error goes to `bot.catch` and the user sees nothing. It should show 0.
15. **Formatting.** Replies use Markdown backticks without `parse_mode`, so the
    backticks appear literally. `/wallet` shows the balance in yoctoNEAR.
16. **Portfolio design.** It makes one `ft_balance_of` RPC call per RHEA-listed
    token (hundreds), each on a newly constructed provider, which gets
    rate-limited quickly. FastNEAR's `GET /v1/account/{id}/full` (or `/ft`)
    returns every FT balance in one call.
17. **Token resolution depends on RHEA's price list.** `resolveNearToken` only
    finds tokens in `get_chain_prices`. NEARly launches trade on a Rhea DCL pool
    **from the next block**, but they won't be in that list yet, and those are
    exactly the tokens a sniper/discovery bot exists for.
    → Resolve any valid account id through on-chain `ft_metadata` (cached in the
    `tokens` table) and only *route* through RHEA.

### Low / hygiene

- `assertValidTokenId` is never called; `normalizeTokenId` lowercases, which
  is fine for NEAR account ids.
- The `positions` and `orders` tables are unused, and the wallet repo writes
  several tables without a transaction (the Neon HTTP driver needs
  `sql.transaction([...])`).
- There is no structured logger yet (PLAN Milestone A). Errors echo raw
  `error.message` to users, which can leak RPC/API internals.
- Test coverage is thin, with none for trading, signer, or repositories. The
  engine and signer interfaces make fakes easy to add.

## 4. Ecosystem context: who we compete with and what we can use

| Area | Finding | Implication for Neyro |
|---|---|---|
| Competitors | **Intear's Bettear bot** is already a NEAR Telegram bot. It offers trade, snipe, trigger orders, copytrade, bridge, new-token/LP alerts, and a price API. Intear also runs an events WebSocket API with 25+ event types and a history service. | Parity on the basics is expected. Differentiate on execution quality (RHEA aggregator), safety (scoped keys, honest fill reporting), and UX. Intear's events and price APIs could also be *consumed* for discovery. |
| Liquidity | **RHEA** = Ref Finance + Burrow merged (2025) and is NEAR's main DEX/lending hub. The unified SDK 2.x aggregates same-chain routes plus NEAR Intents for cross-chain. | This is the right primary router. Cross-chain (Phase 3) is already largely inside the same SDK: same `quote → swap` call, different `toChain`. |
| Launches | **NEARly** (nearly.trade) mints 1B supply into a single Rhea DCL range, so the token is tradeable in the same block with no bonding curve. Many memes pair against `NEARLY`. | Discovery = index NEARly factory events. Execution = multi-hop NEAR→NEARLY→meme via RHEA. The token must be resolvable before it appears in RHEA's price list (defect 17). |
| Cross-chain | The **NEAR Intents 1Click API** is already used by Unstoppable Wallet's Telegram bot. | This is an alternative or backup to RHEA for cross-chain deposits (for example, "fund with USDC on Solana"). That removes the biggest onboarding friction: users no longer have to acquire NEAR first. |
| Data | **FastNEAR**: fast RPC plus `api.fastnear.com/v1/account/{id}/full` for every FT/NFT/staking balance. | This replaces the N-RPC portfolio scan and the `wallet.balance` polling. |

## 5. Recommended target architecture

```
┌──────────────┐   webhook   ┌─────────────────────────────┐
│  Telegram    │────────────▶│  bot-gateway (grammY)       │  stateless, N replicas
└──────────────┘             │  - auth, rate limit, i18n   │
                             │  - renders; no key material │
                             └──────────┬──────────────────┘
                                        │ commands (HTTP/queue)
                             ┌──────────▼──────────────────┐
                             │  core API / trading engine  │  telegram-agnostic
                             │  quote · risk · orders ·    │
                             │  trade state machine        │
                             └───┬─────────┬──────────┬────┘
                   unsigned tx + │         │          │ events
                   trade id      │         │          │
                  ┌──────────────▼──┐  ┌───▼──────┐ ┌─▼──────────────────┐
                  │ signer service  │  │ Postgres │ │ indexer/watchers   │
                  │ KMS-wrapped DEKs│  │ + Redis  │ │ NEARly/RHEA pools, │
                  │ policy checks   │  │ (locks,  │ │ prices (Intear/    │
                  │ (receiver allow-│  │  TTLs,   │ │ FastNEAR), tx      │
                  │  list, caps)    │  │  queues) │ │ reconciler, TP/SL  │
                  └────────┬────────┘  └──────────┘ └────────────────────┘
                           │ signed tx
                           ▼
                 NEAR RPC (FastNEAR primary + FailoverRpcProvider)
```

Key design rules:

- **Trade state machine:** `quoted → confirmed → signing → broadcast(hash) →
  {filled | reverted | unknown} → reconciled`. Every transition is appended to
  `trade_events`. `unknown` is resolved only by the reconciler, never by a timeout.
- **Idempotency end to end:** use the Telegram callback id and the trade id. The
  signer refuses to sign twice for the same trade id.
- **The signer enforces its own policy** and does not trust the engine. It keeps
  an allowlist of `receiverId`s (RHEA router/DEX contracts, `wrap.near`, FT
  contracts only for `storage_deposit`/`ft_transfer_call`), per-user daily
  caps, and never signs `Transfer` to arbitrary accounts except from the
  explicit withdraw flow.
- **Background jobs** (limit/TP/SL, DCA, copy-trade) run as workers that go
  through the same engine → signer path, with the same risk checks.
- **Use webhooks, not long polling,** so the gateway scales horizontally.

## 6. Prioritized next steps

1. **Unbreak CI (small):** fix the `callFunction` params and dead code in
   `portfolio/service.ts`, drop the double JSON parse, and make `rpc.test.ts`
   set `NEAR_RPC_FALLBACK_URL` before import.
2. **Honest execution:** check receipt-level status and the fill in
   `waitForTransactions`, add an `unknown` status plus a tx reconciler, and use
   `quote.expiresAt`.
3. **Network sanity:** make trading mainnet-only, and on testnet make
   `/buy`/`/sell` return a clear "trading is mainnet-only" message.
4. **Key hygiene:** add AAD to AES-GCM (ship it as `cipher_version = 2` with
   migration), refuse the in-memory wallet repo on mainnet, and wrap the wallet
   insert in a transaction.
5. **Persistence:** move pending quotes to Postgres/Redis and add a per-user
   execution lock.
6. **Portfolio via FastNEAR** and wire it into the 💼 button. Fix `parse_mode`
   and show NEAR balances in human units.
7. **Token resolution via `ft_metadata`**, then **NEARly discovery**
   (factory event watcher → `tokens` table → `/new` feed).
8. **Split out the signer service** before any public mainnet launch, and add
   scoped function-call keys.
9. Phase 2 and 3 features (TP/SL, limit, copy trade, cross-chain funding via
   RHEA/Intents).

## Sources

- RHEA unified Swap SDK README (installed `node_modules`, v2.1.5), which covers executor responsibilities, `quote.expiresAt`, and NEAR native = `wrap.near`
- [FastNEAR, NEAR docs](https://docs.near.org/tools/ecosystem-apis/fastnear) · [fastnear-api-server-rs](https://github.com/fastnear/fastnear-api-server-rs)
- [Bettear Bot, Learn NEAR Club](https://learnnear.club/near-ecosystem/bettear-bot/) · [Intear docs](https://docs.intear.tech/)
- [Nearly — token launchpad on NEAR](https://nearly.trade/) · [Nearlytrade contracts](https://github.com/sam3dsol/Nearlytrade)
- [Introducing RHEA Finance](https://learnnear.club/introducing-rhea-finance/) · [RHEA white paper](https://guide.rhea.finance/docs/rhea-finance-white-paper)
- [NEAR Intents 1Click in Unstoppable Wallet (NEAR Protocol on X)](https://x.com/NEARProtocol/status/2064009013948248086)

## Progress (branch `claude/telegram-trading-bot-near-9rbug6`)

Done:
- §6.1 CI green; `npm ci` against the committed lockfile.
- §6.2 Transactions are signed, their hashes journaled, then broadcast.
  Receipt-level failures and FT balance deltas decide filled/reverted.
  A timeout is `unknown`, never `failed`. Quote expiry comes from RHEA.
- §6.3 Trading is mainnet-only, and config rejects mismatched RPCs and a
  missing DB on mainnet.
- §6.4 Wallet keys are AES-GCM v2 with the account id as AAD, the
  key/account match is checked on decrypt, and wallet writes are atomic.
- §6.5 Pending quotes are persisted, with an atomic quoted → executing claim.
- §6.6 Portfolio uses FastNEAR, the UX is HTML-escaped, balances are in
  human units, and the bot answers in private chats only.
- §6.7 Unlisted tokens resolve by contract id via `ft_metadata`.
- Mango-style token panel (DexScreener market card and inline trading keyboard).
- RHEA's wallet-selector actions are converted before signing; only
  FunctionCall and Transfer actions are signed.
- 1% protocol fee capped at $60, appended to RHEA's swap transaction (team
  wallet `widekingdom6862.near`).
- Background reconciler for `unknown` and stale `executing` trades, with user
  notifications.
- NEARly feed (`/new`, Discover) from `nearlytrade.near` `get_launches`, plus
  launch-backed cards for tokens not yet on DexScreener.

Open:
- Automatic refund of fees taken on reverted swaps (recorded as
  `fee_refund_due`; paid manually for now).
- neara.fun and NEARfi launchpads: need an example token to confirm whether
  they trade on RHEA pools or need their own adapter.
- Separate signer service and function-call access keys (§5, §6.8).
- Persist panel state and slippage preferences in the DB (in memory today).
