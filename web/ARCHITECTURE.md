# Neyro Web Terminal — Engineering Handoff

## 1. Purpose

The web/ directory is a separate, non-custodial web terminal for Neyro.

**Hard rule:** do not import, refactor, rename, or modify Telegram bot code to build the web terminal.

The existing Telegram bot remains the production trading/launch application. The web terminal may use existing protocol behavior as a reference and may eventually share pure, dependency-light utilities, but signing/custody and Telegram state stay platform-specific.

## 2. Current branch
Branch: web-terminal-2026-10-02
Base: creator-fees-claim-2026-10-02
Draft PR: #26

## 3. Current implementation
- React + Vite + TypeScript.
- Main entry: web/src/main.tsx.
- Styling: web/src/styles.css.
- No Telegram imports.
- No Telegram Worker imports.
- No encrypted Telegram wallet/private-key imports.
- No database dependency.
- No server-side signing.

### Bulk airdrop foundation
- token contract input
- token decimals
- default amount
- multiple sender-account input
- CSV upload
- TXT/delimited upload
- JSON upload
- streaming CSV/TXT processing when browser streaming APIs are available
- NEAR account-id validation
- duplicate detection
- exact base-unit arithmetic using bigint
- invalid-row reporting
- total token requirement
- 100-recipient batch planning
- recipient preview

The current Start airdrop button is intentionally disabled.

## 4. Why batches exist
NEAR transactions are action batches. The current runtime limit is 100 actions per receipt, and prepaid gas is also constrained. A million-recipient campaign must therefore be split into many transactions rather than attempting one giant transaction.

References:
- NEAR transaction runtime specification: https://nomicon.io/RuntimeSpec/Transactions
- NEP-141 FT transfer standard: https://github.com/near/NEPs/blob/master/neps/nep-0141.md

Treat 100 as an upper action-count ceiling, not a guaranteed safe batch size. Gas, transaction size, and the specific token contract can require smaller batches.

## 5. NEP-141 transfer behavior
A standard ft_transfer calls the token contract, requires sufficient sender balance, requires 1 yoctoNEAR attached deposit, and accepts receiver and amount as strings. Recipient registration is token-contract-specific; standard NEP-145 storage registration is common and must be checked before a large campaign.

## 6. Planned execution architecture

Browser -> wallet connection/signing -> airdrop planner -> campaign state -> NEAR RPC.

The planner owns recipient validation, deduplication, amount normalization, sender allocation and batch construction. RPC is used for metadata, balances, registration checks and transaction status.

## 7. Multi-sender design
A campaign may have several sender accounts. The allocator should validate sender accounts, read fresh token balances, determine available balances, reserve campaign amounts in memory, allocate recipients deterministically, produce immutable batch plans, and require wallet signatures for each sender transaction.

The first implementation should use deterministic allocation rather than dynamically changing sender assignments while transactions are pending.

## 8. Resumability
A million-recipient campaign cannot depend on one browser tab remaining open forever. Campaign state needs a source-file fingerprint, token, sender set, recipient count, total amount, allocation and per-batch states: pending, signing, submitted, success or failed.

The campaign must never silently skip a recipient.

## 9. Retry rules
Retry only when transaction state is known to be safe. RPC/network failure before a transaction hash exists can be retried. A timeout after broadcast is potentially unsafe and must be reconciled before retrying. Never blindly resend an unknown batch because that can double-send tokens.

## 10. Token registration
Before execution, determine whether each recipient is registered with the token contract where standard storage APIs are available. Support already registered, register-where-permitted, and blocked/unavailable states. Do not assume every NEP-141 contract has identical registration behavior.

## 11. Gas and batch sizing
Batch size must be calculated rather than hardcoded to exactly 100. Account for FunctionCall actions, prepaid gas, transaction/receipt limits, attached deposits and token-contract behavior. Start conservatively and increase only after verified execution behavior.

## 12. Security requirements
The web app must remain non-custodial.

Never ask users to paste seed phrases into the website, upload private keys, reuse Telegram encrypted wallet storage, decrypt Telegram wallet keys in browser code, store private keys in localStorage, or send private keys to a backend.

The user's browser wallet should sign web transactions.

## 13. Planned product modules
Dashboard: portfolio, connected account, recent transactions and campaign summaries.
Trade: swap/quote interface using the appropriate NEAR/Rhea/NEAR Intents integration.
Launch: NEARly token launch flow.
Token Tools: Mint, Burn, Lock, Unlock/claim, Pause where supported, Batch transfer and Airdrop.
Developer: Contract inspector, read-only calls, transaction builder and contract simulation/testing tools.

## 14. Token lock requirement
Token locks must be enforced by a smart contract. A database entry saying locked until date X is not a lock.

The eventual lock contract should contain token, amount, beneficiary, unlock timestamp, lock identifier, claim operation and immutable on-chain state.

## 15. Token creation requirement
Token creation should use a known NEP-141-compatible contract/factory pattern rather than inventing a token ABI in the frontend.

Before implementation: identify the supported token contract; verify initialization arguments, metadata behavior, storage registration and mint/transfer/burn behavior; test on NEAR testnet; only then expose mainnet creation.

## 16. What remains
### Phase A — web execution foundation
- [ ] Wallet Selector
- [ ] RPC client
- [ ] FT metadata
- [ ] FT balance
- [ ] storage registration checks
- [ ] sender balance allocator
- [ ] deterministic batch builder
- [ ] gas-aware batch sizing

### Phase B — campaign engine
- [ ] campaign IDs
- [ ] IndexedDB/local persistence
- [ ] resume after reload
- [ ] per-batch state
- [ ] transaction status polling
- [ ] unknown-state reconciliation
- [ ] safe retry
- [ ] CSV result export

### Phase C — multi-sender execution
- [ ] sender-by-sender signing
- [ ] allocation locking
- [ ] balance revalidation before every batch
- [ ] insufficient-balance recovery
- [ ] sender switching UI

### Phase D — token tools
- [ ] token creation
- [ ] mint
- [ ] burn
- [ ] lock
- [ ] unlock/claim
- [ ] batch transfer
- [ ] airdrop

### Phase E — trading/launch
- [ ] browser-wallet NEARly launch
- [ ] Rhea trading
- [ ] NEAR Intents where appropriate
- [ ] portfolio
- [ ] transaction history

## 17. Handoff rules
1. Read this file first.
2. Never modify Telegram files for web-only work.
3. Keep web dependencies inside web/package.json unless there is a clear reason otherwise.
4. Keep signing browser-side/non-custodial.
5. Add tests for amount arithmetic, allocation, batching and retry state.
6. Document protocol assumptions with links.
7. Do not claim million-wallet support until resumability, transaction reconciliation and safe retries are implemented.
8. Test mainnet-facing logic against testnet/sandbox first.

## 18. Definition of million-wallet ready
The product is not million-wallet ready merely because it can parse a million rows.

It is ready only when it can process a million recipients without requiring the entire file in memory, deterministically allocate senders, construct gas-safe batches, persist campaign progress, survive browser reloads/network interruptions, reconcile unknown transactions, prevent duplicate sends, resume safely, export complete results, and handle failures without silently dropping recipients.

## 19. Current status
The current branch is the foundation only. The airdrop UI/planner is intentionally ahead of the signing layer.

Telegram remains untouched.