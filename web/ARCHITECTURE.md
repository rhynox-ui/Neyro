# Neyro Web Terminal — Engineering Handoff

## 1. Purpose

The `web/` directory is a separate, non-custodial web terminal for Neyro.

**Hard rule:** do not import, refactor, rename, or modify Telegram bot code to build the web terminal.

The existing Telegram bot remains the production trading/launch application. The web terminal may inspect it for protocol/configuration references, but signing, custody, execution state and web UI remain platform-specific.

## 2. Current branch
Branch: `web-terminal-2026-10-02`  
Base: `creator-fees-claim-2026-10-02`  
Draft PR: #26

## 3. Current implementation

- React + Vite + TypeScript.
- Main entry: `web/src/main.tsx`.
- No Telegram imports.
- No Telegram Worker imports.
- No encrypted Telegram wallet/private-key imports.
- No server-side signing.
- IndexedDB campaign persistence.
- Deterministic NEP-141 transfer planning.
- Read-only NEAR RPC and FT helpers.
- Hardened multi-sender allocation checks.
- Mint/Lock product-fee model.

The Start Airdrop button remains intentionally disabled.

## 4. Bulk airdrop foundation

Implemented:
- token contract input;
- token decimals;
- default amount;
- multiple sender-account input;
- CSV/TXT/JSON recipient ingestion;
- streaming CSV/TXT processing when browser streaming APIs are available;
- NEAR account-id validation;
- duplicate detection;
- exact base-unit arithmetic with `bigint`;
- invalid-row reporting;
- total token requirement;
- deterministic multi-sender allocation primitive;
- deterministic transfer batch construction;
- recipient preview.

For very large files, the parser avoids loading CSV/TXT bytes as one giant string when `TextDecoderStream` is available. The UI still retains parsed rows for preview/planning, so true million-wallet execution will require further memory-bounded planning before production use.

## 5. NEP-141 transfer behavior

A standard `ft_transfer` calls the token contract, requires sufficient sender token balance and 1 yoctoNEAR attached deposit, and accepts receiver and amount as strings. Recipient registration is token-contract-specific; standard NEP-145 storage registration is common and must be checked before a large campaign.

References:
- NEP-141: https://github.com/near/NEPs/blob/master/neps/nep-0141.md
- NEAR runtime transactions: https://nomicon.io/RuntimeSpec/Transactions

## 6. Multi-sender allocation safety

The allocator now performs two checks:

1. **Aggregate check:** total sender token balance must cover the total campaign amount.
2. **Individual allocation check:** recipients are assigned deterministically in sender insertion order; each recipient must fit within one sender's remaining balance.

The output contains explicit sender allocations and each allocation's total amount.

This is intentionally deterministic. It does not mutate assignments after a batch is signed or submitted.

Future execution must still re-read balances immediately before signing each batch because on-chain balances can change after the initial plan.

## 7. Why batches exist

NEAR transactions have action-count and gas/runtime constraints. The runtime ceiling is not a promise that 100 token transfers are always safe.

The current batch builder uses a conservative gas-aware default of 8 `ft_transfer` actions when each call is configured for 30 Tgas. NEAR currently caps total prepaid gas at 300 Tgas per signed transaction, so the planner reserves 60 Tgas and also respects the 100-action receipt ceiling. Lower per-action gas can allow more actions, but the planner never exceeds either protocol limit.

## 8. Resumability

Campaign state is persisted in browser IndexedDB.

Stored state includes:
- campaign id;
- source fingerprint;
- token/sender metadata;
- recipient and amount totals;
- per-batch status;
- transaction hash/error information.

No private keys, seed phrases, encrypted Telegram wallet records or signer secrets are persisted.

Batch states:
- pending
- signing
- submitted
- success
- failed
- unknown

**Unknown is not retryable.** A timeout after broadcast does not prove failure. The future executor must reconcile the transaction before allowing a resend.

## 9. Planned execution architecture

Browser wallet -> preflight -> immutable campaign plan -> wallet signing -> NEAR RPC -> persisted reconciliation state.

Required execution gates:
- connected browser wallet;
- valid sender account;
- fresh native and token balances;
- token registration preflight;
- conservative gas/batch sizing;
- explicit transaction preview;
- browser wallet signature;
- transaction hash persistence;
- status reconciliation;
- safe retry only after known failure.

The web terminal must never fall back to Telegram signing.

## 10. Wallet and custody rules

Never:
- ask for a seed phrase;
- ask for a private key;
- import Telegram encrypted wallet storage;
- decrypt Telegram wallet keys in browser code;
- store private keys in localStorage;
- send private keys to a backend;
- use the Telegram treasury key as a browser signer.

The connected user's browser wallet is the only intended web signer.

## 11. Token-tool fees

Product fees are defined in `web/src/token-tools/fees.ts`:

- Mint fee: **1 NEAR**
- Lock fee: **1 NEAR**
- Denomination: native NEAR
- Internal unit: yoctoNEAR

The fee is separate from:
- token amount;
- contract-required storage deposit;
- gas;
- any future sponsorship mechanism.

The pre-signing confirmation must display all four categories separately.

## 12. Fee treasury

The web terminal references the existing Neyro bot treasury:

`widekingdom6862.near`

Current web policy:
- Mint: 1 NEAR -> `widekingdom6862.near`
- Lock: 1 NEAR -> `widekingdom6862.near`

This is a **reference to the configured fee recipient**, not a browser signing account.

Before mainnet execution, verify the production treasury configuration again. If the treasury changes, update only web configuration and documentation; do not modify Telegram code for the web task.

## 13. Gas sponsorship boundary

Fee collection and gas sponsorship are separate.

The repository currently provides evidence for the treasury account but does **not** provide evidence of a dedicated browser relayer/sponsor account or provider.

Therefore:
- current web mode: user pays gas;
- relayer mode: blocked until a dedicated sponsor account and provider are explicitly configured;
- treasury funds must not be exposed to the browser.

The web sponsorship abstraction exists specifically to prevent an assumption that the fee treasury is automatically a gas sponsor.

## 14. Token registration

Before a campaign can execute, the executor must determine recipient registration where the token supports a standard storage API.

States should distinguish:
- registered;
- not registered;
- storage registration required and permitted;
- registration unavailable/unknown.

Do not automatically transfer to an unregistered account when the token contract would reject the transfer.

## 15. Token lock requirement

A token lock must be enforced by an on-chain smart contract.

A database record saying “locked until date X” is not a lock.

The eventual lock contract should contain:
- token;
- amount;
- beneficiary;
- unlock timestamp;
- lock identifier;
- claim operation;
- immutable on-chain state.

## 16. Token creation requirement

Token creation must use a known NEP-141-compatible contract/factory pattern.

Before implementation:
1. identify the supported contract/factory;
2. verify initialization arguments;
3. verify metadata;
4. verify storage registration;
5. verify mint/transfer/burn behavior;
6. test on testnet;
7. only then expose mainnet creation.

Do not invent an ABI in the frontend.

## 17. Remaining work

### Phase A — execution foundation
- [x] RPC client
- [x] FT metadata
- [x] FT balance
- [x] storage registration read
- [x] deterministic sender allocation primitive
- [x] deterministic batch builder
- [x] conservative gas-aware batch sizing
- [x] provider-neutral browser wallet connector boundary
- [x] Wallet Selector/My NEAR Wallet adapter implemented but not wired into execution UI

### Phase B — campaign engine
- [x] campaign model
- [x] IndexedDB persistence
- [ ] resume after reload
- [ ] transaction status polling
- [ ] unknown-state reconciliation
- [ ] safe retry executor
- [ ] CSV result export
- [ ] memory-bounded million-wallet planner

### Phase C — multi-sender execution
- [ ] sender-by-sender wallet signing
- [ ] allocation locking
- [ ] fresh balance revalidation before every batch
- [ ] insufficient-balance recovery
- [ ] sender switching UI

### Phase D — token tools
- [ ] supported token creation adapter
- [ ] mint
- [ ] burn
- [ ] lock
- [ ] unlock/claim
- [ ] batch transfer
- [ ] airdrop execution

### Phase E — trading/launch
- [ ] browser-wallet NEARly launch
- [ ] Rhea trading
- [ ] NEAR Intents where appropriate
- [ ] portfolio
- [ ] transaction history

## 18. Million-wallet readiness definition

Parsing a million rows is not enough.

The product is ready only when it can:
1. ingest large files without an unbounded in-memory representation;
2. deterministically allocate sender balances;
3. build gas-safe batches;
4. persist progress;
5. survive reload/network interruptions;
6. reconcile unknown transactions;
7. prevent duplicate sends;
8. resume safely;
9. export complete results;
10. handle failures without silently dropping recipients.

Until those gates are implemented, production airdrop execution stays disabled.

## 19. Handoff rules

1. Read this document before continuing.
2. Never modify Telegram files for web-only work.
3. Keep web dependencies under `web/package.json`.
4. Keep signing browser-side and non-custodial.
5. Test arithmetic, allocation, batching and state transitions.
6. Document protocol assumptions and source references.
7. Never claim million-wallet readiness prematurely.
8. Test mainnet-facing logic on testnet/sandbox first.
9. After every web code change, verify that the diff contains only web/workflow files.
10. Do not merge PR #26 unless explicitly requested.

## 20. Current checkpoint

Latest work hardens the multi-sender allocator with aggregate-balance validation and explicit allocation totals. The web terminal remains planning/read-only for execution.

Telegram code remains untouched.

## 21. Browser wallet boundary and sender preflight

A web-only wallet connector boundary now exists at `web/src/wallet/connector.ts`.

The interface intentionally exposes:
- connect;
- disconnect;
- account discovery;
- sign-and-send.

The default `LockedWalletConnector` cannot sign. This prevents the UI from accidentally gaining a private-key or Telegram-signing fallback while the real browser wallet integration is being selected.

Current research confirms NEAR Wallet Selector v10 remains usable and exposes wallet signing through its wallet abstraction. The current Wallet Selector project also recommends evaluating HOT Connect for longer-term integration. We will keep the Neyro interface provider-neutral so either can be adapted without changing campaign logic.

References:
- NEAR Wallet Selector: https://github.com/near/wallet-selector
- Wallet Selector wallet API: https://github.com/near/wallet-selector/blob/main/packages/core/docs/api/wallet.md

### Fresh sender preflight

`web/src/preflight.ts` now performs a read-only preflight for a campaign:
- token metadata;
- native NEAR balance for every unique sender;
- token balance for every unique sender;
- storage registration state;
- aggregate token balance versus campaign requirement.

This is deliberately a fresh read immediately before execution planning. It does not reserve funds, sign, broadcast, or mutate anything.

The preflight returns:
- `registered`;
- `not-registered`;
- `unknown` storage status.

A successful preflight is not an execution authorization. Before signing, balances must be revalidated again and gas/registration/signer checks must pass.

## 22. Current checkpoint

Latest implementation adds:
- a provider-neutral browser wallet boundary;
- a locked/no-op connector so signing cannot occur accidentally;
- fresh read-only sender native/token balance preflight;
- token storage-registration status per sender;
- aggregate campaign-balance verification;
- a web UI control to run that preflight against NEAR mainnet.

The preflight is informational and does not authorize execution. Browser signing, balance revalidation, gas-aware sizing and transaction reconciliation are still required before enabling Start.

Telegram remains untouched.

## 23. Current checkpoint

Latest work adds the wallet boundary and fresh sender/token balance preflight. Browser signing remains locked.

Telegram remains untouched.

## 24. Gas-safe batching checkpoint

`web/src/airdrop/gas-planner.ts` now models the two relevant NEAR limits independently:

- maximum actions per receipt: 100;
- maximum total prepaid gas per signed transaction: 300 Tgas.

The default NEP-141 transfer action attaches 30 Tgas. The web planner reserves 60 Tgas for fixed/runtime overhead, leaving 240 Tgas for transfer calls. That produces a conservative default of 8 transfers per transaction.

The batch builder now rejects a requested batch size that exceeds the calculated gas-safe limit instead of silently constructing a transaction that can fail protocol validation.

This is a conservative planner, not a claim that every token contract consumes exactly 30 Tgas. Before production execution, measured gas behavior for the supported token contracts should be used to tune the per-action gas and reserve.

References:
- NEAR gas: https://nomicon.io/architecture/how/gas.html
- NEAR transaction limits: https://nomicon.io/RuntimeSpec/Transactions

## 25. Current checkpoint

The web terminal now has a conservative gas-aware batch planner and refuses to construct batches that exceed the calculated prepaid-gas budget.

Browser signing remains locked. Telegram code remains untouched.

## 26. Transaction action boundary

`web/src/execution/transaction-builder.ts` now converts an immutable planned FT batch into the web wallet connector's action format. It does not sign or broadcast anything.

The builder enforces that the batch sender matches the signer account and keeps the token contract as the transaction receiver. Product fees are represented separately as native NEAR `Transfer` actions to the configured treasury.

This separation is intentional: token transfers, native product fees, gas and any future sponsorship must remain independently visible in the pre-signing transaction summary.

## 27. Current checkpoint

The web terminal now has:
- conservative gas-safe batch planning;
- a provider-neutral browser wallet boundary;
- fresh read-only sender preflight;
- a transaction action adapter that still cannot sign.

## 28. Browser wallet adapter checkpoint

`web/src/wallet/selector.ts` now contains the first concrete browser-wallet adapter behind the provider-neutral connector interface.

It uses:
- `@near-wallet-selector/core` 10.1.4;
- `@near-wallet-selector/my-near-wallet` 10.1.4;
- NEAR mainnet;
- the existing connector interface rather than exposing Wallet Selector types to campaign code.

The adapter:
- discovers the existing signed-in account;
- requests browser-wallet sign-in when no account is connected;
- exposes account discovery and sign-out;
- converts only the explicitly approved web action types into Wallet Selector actions;
- requires the requested signer to be one of the connected accounts;
- requires every action receiver to equal the transaction receiver;
- returns a transaction hash when the wallet provides an execution outcome.

Browser wallets may redirect for signing and therefore may not return a final transaction outcome immediately. The campaign engine must treat an absent hash as an unresolved submission, not as a failed transaction.

The adapter is **not wired to Start Airdrop yet**. This is deliberate. The remaining gates are fresh revalidation immediately before signing, immutable campaign-state transition to `signing`, submission/reconciliation handling, and safe resume after redirect/reload.

References:
- Wallet Selector core: https://www.npmjs.com/package/@near-wallet-selector/core
- Wallet Selector wallet API: https://github.com/near/wallet-selector/blob/main/packages/core/docs/api/wallet.md

## 29. Current checkpoint

The web branch now has:
- gas-safe batch planning;
- fresh sender/token preflight;
- immutable transaction action builders;
- a concrete mainnet browser-wallet adapter;
- adapter unit tests;
- no Telegram code changes.

Execution remains disabled until the campaign state machine, balance revalidation and unknown-transaction reconciliation are connected around the signer.
