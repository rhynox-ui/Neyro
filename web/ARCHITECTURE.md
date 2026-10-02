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

Before a campaign can execute, the web preflight now checks recipient registration where the token exposes the NEP-145 storage API.

The preflight distinguishes:
- registered;
- not registered;
- storage API unavailable/unknown.

The campaign is blocked when any recipient is unregistered or registration cannot be verified. The current web branch does not yet perform the registration transaction itself; the next step is a dedicated, persisted registration flow that reads storage_balance_bounds instead of guessing a deposit.

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

The adapter is now wired to Start Airdrop through `web/src/execution/executor.ts`. The executor performs fresh revalidation immediately before each signing step, persists the `signing` state first, records the transaction hash before finality polling, and stops safely on unresolved outcomes.

References:
- Wallet Selector core: https://www.npmjs.com/package/@near-wallet-selector/core
- Wallet Selector wallet API: https://github.com/near/wallet-selector/blob/main/packages/core/docs/api/wallet.md

## 29. Execution checkpoint — airdrop execution is now wired

The web terminal now has a complete execution path for NEP-141 bulk transfers:

1. Build a deterministic campaign fingerprint from token, decimals, sender set and recipient amounts.
2. Read fresh sender token balance, native NEAR balance, storage registration and current gas price immediately before each batch.
3. Allocate recipients deterministically across the fresh sender balances.
4. Build conservative FT transfer batches with exact base-unit strings and 1 yoctoNEAR per `ft_transfer`.
5. Require the sender account to be connected to the browser wallet before that sender's batch can sign.
6. Persist the batch as `signing` before opening the wallet.
7. Submit through the browser-wallet connector.
8. Persist the transaction hash as `submitted` before waiting for finality.
9. Mark `success` only after the NEAR RPC reports a successful final transaction.
10. Treat missing hashes, wallet interruptions and uncertain RPC outcomes as `unknown`; never automatically resend them.
11. Persist exact recipient wallet + base-unit amount data inside every campaign batch so pending batches can be reconstructed after reload.
12. Allow explicit reconciliation of `unknown`/`submitted` batches before retrying.

Native gas safety is conservative: the executor checks the sender's current native NEAR balance against the batch's full prepaid-gas budget at the current RPC gas price plus the attached 1-yocto deposits. This is a safety ceiling, not an estimate of actual gas consumed.

### What is still deliberately not implemented

The terminal does not invent protocol methods for Mint, Burn, Lock, Unlock, Launch, Swap or Developer calls. Those modules remain foundation views until their exact contract interfaces are verified and implemented. The 1 NEAR Mint fee and 1 NEAR Lock fee are already modeled separately and route to `widekingdom6862.near`, but no token-tool transaction is enabled merely from the fee model.

Gas sponsorship also remains separate from fee collection. The repository has evidence for the treasury fee recipient but no verified dedicated relayer/sponsor account. The web default therefore remains user-pays-gas.

### Handoff rule

A future contributor continuing execution work should start in:
- `web/src/execution/executor.ts` — execution lifecycle, revalidation and reconciliation;
- `web/src/execution/transaction-builder.ts` — wallet action construction;
- `web/src/campaign/model.ts` — persisted safety state;
- `web/src/campaign/storage.ts` — browser persistence;
- `web/src/wallet/selector.ts` — browser-wallet boundary.

Do not modify Telegram code to make web execution work.


## 30. State audit — 2026-10-02

This section records the state verified before continuing implementation.

### Repository shape

The web branch is currently **75 commits ahead** of `creator-fees-claim-2026-10-02`. The audited diff contains only:
- `.github/workflows/web-ci.yml`;
- `web/**`.

No Telegram source path is part of this web-terminal diff.

### Execution path now present

The current web tree contains:
- `web/src/execution/executor.ts`;
- `web/src/execution/executor.test.ts`;
- `web/src/execution/transaction-builder.ts`;
- campaign model/storage;
- gas planner;
- NEAR RPC;
- FT read helpers;
- sender preflight;
- Wallet Selector/My NEAR Wallet adapter.

The executor is responsible for campaign creation/resume, per-batch fresh checks, browser-wallet signing, persistence of `signing` and `submitted` states, finality checking, and explicit reconciliation of `unknown`/submitted transactions.

### Current wallet adapter correction

The earlier CI failure identified three Wallet Selector typing problems. The current branch's selector implementation has since been adjusted to:
- use `accounts: []` for the My NEAR Wallet sign-in path;
- use Wallet Selector `actionCreators` instead of manually shaped action objects;
- handle the selector wallet's returned signing result through the local execution-outcome shape.

This needs a **new Web Terminal CI run** before being considered verified.

### Last verified CI result

The last audited Web Terminal CI run before the selector correction was:
- Run `37028087667`;
- `npm install`: passed;
- `npm run typecheck`: failed;
- tests/build: skipped.

The failure was isolated to `web/src/wallet/selector.ts`.

The main repository CI run for that same checkpoint succeeded, but it does not replace the web CI.

### Execution safety status

The web terminal is now architecturally wired for NEP-141 bulk execution, but production readiness still requires:
1. green web typecheck/test/build;
2. testnet end-to-end signing with a real test token;
3. verification that Wallet Selector returns a usable transaction hash/outcome across its redirect/signing behavior;
4. reconciliation tests against real final/failed transaction states;
5. explicit reload/resume testing;
6. safe retry testing after confirmed failure;
7. sender-switching and insufficient-balance recovery testing.

Until those are verified, this documentation should not be interpreted as a claim that production mainnet airdrops are fully validated.

### Static-data rule

The supplied Mango-style HTML references are design references only. Production UI must derive account, balance, transaction and campaign values from actual application state or verified chain reads. Do not copy their demo wallets, balances, transactions or fake status values.

### Immediate next checkpoint

Fix/verify CI first. Then run the execution path on NEAR testnet before enabling or expanding mainnet execution.

**Telegram code remains off-limits.**


## 31. Web Terminal Roadmap — 2026-10-02

This roadmap is the implementation order for the separate Neyro web terminal. It is intentionally execution-first: every step must preserve non-custodial browser signing, deterministic campaign state, and the rule that Telegram code is reference-only.

### Stage 0 — Repository and UI foundation

**Status: COMPLETE**

- [x] Isolated web application under `web/`
- [x] React + Vite + TypeScript
- [x] CI workflow for web typecheck/test/build
- [x] Mango-style terminal shell adapted for Neyro
- [x] Responsive grouped navigation
- [x] Dynamic wallet/account display
- [x] No copied demo balances, wallets, transactions or fake status data
- [x] Unsupported modules show foundation state instead of fabricated functionality
- [x] Telegram source remains untouched

### Stage 1 — Airdrop planning and safety foundation

**Status: COMPLETE**

- [x] CSV/TXT/JSON recipient ingestion
- [x] Streaming text ingestion where supported
- [x] NEAR account validation
- [x] Duplicate detection
- [x] Exact bigint token arithmetic
- [x] Multi-sender allocation
- [x] Deterministic campaign fingerprint
- [x] Deterministic NEP-141 transfer batches
- [x] Conservative gas-aware batch sizing
- [x] NEAR RPC read layer
- [x] FT metadata/balance/storage reads
- [x] Fresh sender preflight
- [x] IndexedDB campaign persistence
- [x] Campaign/batch state machine

### Stage 2 — Browser execution

**Status: WIRED; VERIFICATION REQUIRED**

- [x] Provider-neutral wallet connector
- [x] My NEAR Wallet / Wallet Selector adapter
- [x] Transaction action adapter
- [x] Fresh sender checks immediately before signing
- [x] Persist `signing` before wallet approval
- [x] Persist transaction hash as `submitted`
- [x] Finality verification
- [x] Unknown outcome protection
- [x] Explicit reconciliation path
- [x] Green Web Terminal CI after the latest Wallet Selector correction
- [ ] Real NEAR testnet signing with a test token
- [ ] Verify wallet redirect/signing return behavior
- [ ] Verify final/failed transaction reconciliation against live RPC
- [ ] Verify reload/resume behavior
- [ ] Verify safe retry after confirmed failure

**Gate:** Do not treat mainnet airdrop execution as production-validated until every unchecked item above passes.

### Stage 3 — Production-grade campaign engine

**Status: NEXT**

- [ ] Resume campaigns automatically after reload
- [ ] Persist and restore active campaign selection
- [ ] Prevent duplicate execution across tabs
- [ ] Revalidate balances before every batch
- [ ] Recalculate/reject stale allocations safely
- [ ] Sender switching when multiple browser accounts are required
- [ ] Insufficient-balance recovery without silently dropping recipients
- [ ] Complete per-recipient result tracking
- [x] Recipient NEP-145 registration preflight
- [ ] Persisted in-terminal recipient registration transaction
- [ ] CSV result export
- [ ] Network/RPC interruption recovery
- [ ] Unknown transaction reconciliation UI
- [ ] Safe retry UI limited to confirmed failures
- [ ] Clear pre-signing transaction summary

### Stage 4 — Million-wallet execution hardening

**Status: NOT READY**

The goal is not simply to parse one million rows. The planner must operate with bounded memory and preserve deterministic execution.

- [ ] Chunked/streaming planning without retaining the full recipient dataset
- [ ] Persistent source/chunk checkpoints
- [ ] Deterministic allocation across large datasets
- [ ] Batch generation from bounded chunks
- [ ] Duplicate detection that does not require an unbounded in-memory set
- [ ] Crash/reload recovery from the last committed checkpoint
- [ ] Complete result ledger/export
- [ ] Performance testing with large synthetic datasets
- [ ] Browser memory profiling on realistic mobile/desktop targets

**Gate:** Keep large-scale Start/Execute flows disabled until bounded-memory planning and recovery are demonstrated.

### Stage 5 — Token tools

**Status: FOUNDATION ONLY**

Fees are already modeled:
- Mint: 1 NEAR
- Lock: 1 NEAR
- Treasury: `widekingdom6862.near`

Implementation order:

1. [ ] Verify the exact supported NEP-141 token creation contract/factory.
2. [ ] Implement token creation adapter from the verified ABI/interface.
3. [ ] Implement mint with verified contract arguments.
4. [ ] Implement burn with verified contract arguments.
5. [ ] Implement lock using an on-chain lock contract.
6. [ ] Implement unlock/claim.
7. [ ] Implement batch transfer.
8. [ ] Reuse the campaign engine for airdrop execution.
9. [ ] Add operation history and result export.

**Rule:** Never invent contract methods or ABI fields from the frontend.

### Stage 6 — NEARly launch

**Status: NOT STARTED**

- [ ] Verify current NEARly launch contract/interface
- [ ] Verify supported launch pairs and decimals
- [ ] Verify launch parameters and required deposits
- [ ] Build browser-wallet launch transaction
- [ ] Pre-signing summary
- [ ] Submit and reconcile launch transaction
- [ ] Show resulting token/launch reference from confirmed chain state
- [ ] Test on testnet/sandbox where the protocol supports it

The Telegram Neyro launch implementation may be referenced for protocol/configuration understanding but must not be modified for the web terminal.

### Stage 7 — Trading

**Status: NOT STARTED**

- [ ] Verify supported Rhea trading interface
- [ ] Build quote/read layer
- [ ] Browser-wallet swap execution
- [ ] Slippage/deadline controls where supported
- [ ] Transaction simulation/preflight where available
- [ ] Execution reconciliation
- [ ] Portfolio/balance aggregation
- [ ] Orders/trade history

### Stage 8 — Developer tools

**Status: NOT STARTED**

- [ ] Contract Inspector
- [ ] Read-only Contract Call
- [ ] Safe transaction builder
- [ ] Explicit receiver/method/arguments review
- [ ] Gas/deposit validation
- [ ] Browser-wallet signing
- [ ] Transaction reconciliation

Developer tools must never provide a generic “send anything” path without an explicit transaction preview and wallet confirmation.

### Stage 9 — History and observability

**Status: NOT STARTED**

- [ ] Transaction history from verified chain state
- [ ] Airdrop campaign history
- [ ] Token-operation history
- [ ] Batch-level status and hashes
- [ ] Failure/reconciliation details
- [ ] Exportable campaign results
- [ ] No fake/static history rows

### Stage 10 — Sponsorship, if required

**Status: BLOCKED ON VERIFIED INFRASTRUCTURE**

- [x] Separate fee collection from gas sponsorship
- [x] Default to user-pays-gas
- [ ] Identify a dedicated sponsor/relayer account
- [ ] Identify the supported sponsorship provider/protocol
- [ ] Verify authorization and spending limits
- [ ] Implement an explicit sponsorship adapter
- [ ] Add sponsor failure/recovery handling
- [ ] Never expose treasury or sponsor private keys to browser code

The existing treasury `widekingdom6862.near` is a fee recipient. It must not be treated as a sponsor unless verified infrastructure explicitly proves that role.

### Release gates

The web terminal should move toward mainnet feature enablement in this order:

1. **CI gate** — typecheck, tests and build are green.
2. **Protocol gate** — every contract method used by the web terminal is verified from authoritative protocol/interface sources.
3. **Wallet gate** — browser-wallet signing and returned outcomes work reliably.
4. **Execution gate** — fresh balances, registration, gas, signing and reconciliation are all enforced.
5. **Recovery gate** — reload, unknown transaction, RPC failure and confirmed-failure retry paths are tested.
6. **Scale gate** — large-file planning is bounded and recoverable before claiming million-wallet readiness.
7. **Mainnet gate** — only verified features are enabled; unfinished modules remain visibly disabled/foundation-only.

### Working rule for future contributors

When continuing this roadmap, work on the earliest incomplete stage unless a later-stage task is required to unblock it. Keep changes inside `web/` (plus the web CI workflow when necessary), update this roadmap/checkpoint after meaningful milestones, and never modify Telegram code to make a web feature work.

## 31. Execution checkpoint — campaign result export

The web terminal now exposes a persisted campaign CSV export at `web/src/campaign/export.ts`.

The export is derived only from IndexedDB campaign state and includes one row per persisted recipient with:
- campaign id;
- batch id;
- sender account;
- exact base-unit amount;
- batch status;
- transaction hash when known;
- error text when present.

CSV values are escaped for commas, quotes and line breaks. The UI exposes **Export CSV** from the campaign execution panel.

This is a result/export feature, not an execution shortcut. It does not create transactions, change campaign state, or retry batches.

The current export iterates the persisted campaign object in memory. Million-wallet production readiness still requires a memory-bounded planner/persistence strategy; this export implementation must not be interpreted as proof of million-row scalability.

The latest Wallet Selector documentation confirms that `getAccounts()` can expose multiple signed-in accounts and that `signAndSendTransaction` may return no outcome for browser wallets that redirect. The execution layer therefore continues to require explicit signer-account matching and treats missing transaction hashes as unresolved rather than successful.

Reference: https://github.com/near/wallet-selector/blob/main/packages/core/docs/api/wallet.md

## 32. Execution checkpoint — deterministic sender allocation

Sender allocation now uses deterministic best-fit decreasing: larger recipient transfers are assigned first, with ties preserving source order, and each transfer selects the sender with the smallest remaining balance that can cover it. This reduces avoidable balance fragmentation compared with simple first-fit allocation.

Aggregate balance remains only a necessary condition, not a proof that arbitrary recipient amounts can be partitioned across sender accounts. If the deterministic allocator cannot place a recipient, execution stops before signing. Exact optimal bin-packing is intentionally not claimed; million-wallet planning will need bounded-memory allocation semantics and explicit handling of unsatisfiable distributions.


## 33. UI checkpoint — state-driven terminal surface

The Web Terminal presentation was tightened after the first Cloudflare deployment review.

Changes:
- removed demo-looking token, sender and amount values from the visible form;
- token decimals are now loaded from verified ft_metadata instead of presenting a hardcoded default;
- token identity is shown from the live contract metadata after loading;
- wallet connection state is shown from the actual browser wallet state;
- removed unrelated Mint/Lock fee chips from the bulk-transfer surface;
- reduced card, heading and navigation density;
- redesigned the mobile navigation as a horizontal terminal navigation rather than shrinking the desktop sidebar;
- added responsive header wallet controls;
- preserved the existing real preflight, campaign persistence and execution path.

The UI remains intentionally conservative: unsupported modules are not presented as functional trading/launch features, and no fabricated balances, transactions or campaign statistics are rendered.


## 2026-10-02 — Real overview/history checkpoint

The terminal landing view is now state-driven instead of presenting an empty prototype shell:

- Overview reads the connected browser wallet's live native NEAR balance from NEAR mainnet.
- Overview campaign metrics come only from persisted IndexedDB campaign state.
- Airdrop Campaigns lists locally persisted campaigns with real token contracts, recipient counts, batch counts, status and update time.
- Opening a persisted campaign returns to the execution view without creating new mock state.
- Campaign execution and reconciliation now synchronize the overview/history state in memory.
- No private keys, Telegram wallet state, fabricated balances, fabricated transactions or fabricated campaign statistics are introduced by these views.
- Protocol modules that are not verified remain disabled rather than being represented as functional.


## 2026-10-02 — Terminal layout reset

The visible terminal shell was rebuilt to remove prototype/static presentation:

- navigation now exposes only currently implemented web views instead of clickable placeholder modules;
- removed the unused theme switcher from the production surface;
- removed static token/sender demo values from form placeholders;
- default amount is disabled until verified token metadata is loaded;
- bulk-transfer hero and cards use compact terminal proportions;
- desktop content width and sidebar width were reduced to eliminate excessive whitespace;
- mobile rendering switches to a compact sticky navigation and single-column cards before the layout becomes cramped;
- wallet state remains live and execution data remains sourced from chain/IndexedDB state.

This is a presentation-only reset around the existing execution boundary; Telegram code and the underlying execution modules remain unchanged.


## 2026-10-02 — Terminal surface restored without demo state

- Restored the Mango-style information architecture as navigation: Trade, Launch, Token Tools, Developer and History.
- Kept protocol-specific write flows gated when their exact web transaction interfaces are not verified.
- Added live Portfolio reads for the connected NEAR account and the token currently loaded in Bulk Transfer.
- Added a live read-only Contract Inspector using final NEAR RPC.
- Added persisted transaction history derived from campaign batch transaction hashes.
- Unsupported modules now explain the real integration boundary instead of rendering fabricated balances, quotes, orders, fees or deployment results.
- Removed illustrative sender account placeholders.
- Telegram bot and Worker code remain untouched.


## 2026-10-02 — Live protocol surfaces

- Added a browser-side NEARly launch adapter under `web/src/protocol/nearly.ts`.
- NEARly launch pairs are read from `nearlytrade.near::get_quotes`; launch costs are read from `quote_launch` immediately before signing.
- Launch arguments preserve NEARly's documented optional metadata, pair, first-buy and tax fields.
- Added a live RHEA SmartRouter quote surface. Quotes are fetched at request time, validated for positive output, minimum output and signature/message presence, and treated as short-lived.
- Swap execution remains gated while the browser transaction lifecycle is hardened for RHEA wrapping, token registration and multi-transaction routes.
- No Telegram bot, Worker or production signer code was modified.


## 2026-10-02 — Neyro brand asset

- Added the Neyro network logo as `web/public/neyro-logo.svg` and use it for the terminal sidebar brand mark and browser favicon.
- The logo is presentation-only; it does not participate in wallet, signing, protocol, or execution state.
- Telegram bot and Worker code remain untouched.


## 2026-10-02 — Swap UI and theme pass

- Reworked the Swap surface into a conventional DEX flow: From/To token panels, amount entry, token switch control, slippage presets, live route card and a clear review/sign boundary.
- Increased terminal typography and control sizing for mobile readability while keeping compact desktop density.
- Added persistent dark/light mode using local browser preference storage.
- Light mode covers the terminal shell, navigation, forms, cards and swap surface.
- Swap quote display now formats input/output/minimum amounts using the verified token decimals returned by NEAR metadata.
- RHEA execution remains disabled until the transaction lifecycle is safe for wrapping, registration and multi-transaction reconciliation.
- Telegram bot and Worker code remain untouched.


## 2026-10-02 — Swap interaction checkpoint

- Added a real-time quote expiry countdown instead of a static 45-second label.
- Expired quotes are visibly invalidated and require a fresh quote before the review boundary can be used.
- Added a compact swap settings popover for custom slippage while preserving the preset controls.
- Changing slippage invalidates the current quote.
- No swap execution was enabled by this UI pass; RHEA signing remains gated until wrapping, token registration and multi-transaction reconciliation are verified.
- Telegram bot and Worker code remain untouched.


## Swap balance checkpoint

The Swap screen now reads the connected account's live balance for the selected input asset. Native NEAR uses the account balance; NEP-141 assets use ft_metadata and ft_balance_of. The displayed token symbol and decimals come from live metadata, and a MAX control fills the exact live base-unit balance converted for display. Changing the input contract invalidates the quote. No balance, symbol, price, or execution state is hardcoded.


## 2026-10-02 — Terminal readability checkpoint

- Increased the terminal's sidebar/logo and primary navigation sizing so the Neyro brand and controls remain readable on smaller browser viewports.
- Added responsive breakpoints at 900px and 640px for the terminal shell, sidebar, main content spacing and Swap surface.
- Kept the conventional Swap layout, live quote/balance behavior and dark/light theme unchanged; this checkpoint is presentation-only.
- No Telegram bot, Worker or signer code was modified.


## 2026-10-02 — Stable Pages entry freshness

- Added `web/public/_headers` so `/` and `/index.html` use `Cache-Control: no-store`.
- This protects the stable `neyro-terminal.pages.dev` entry document from retaining an older SPA shell after a new Git-integrated Pages deployment.
- Hash deployment URLs remain immutable snapshots; the stable project URL is the intended continuously updated entry point.
- No Telegram bot, Worker, wallet custody, or execution code was modified.


## 2026-10-02 — Sidebar navigation cleanup

- Removed the Developer and History groups from the visible Web Terminal sidebar.
- Existing implementation modules remain in the codebase for the current execution/history architecture; this change only removes those navigation entries from the primary surface.
- No Telegram bot, Worker, wallet custody, or execution code was modified.


## 2026-10-02 — Orders navigation cleanup

- Removed the Orders entry from the visible Trade navigation.
- The primary sidebar now exposes only currently relevant Web Terminal surfaces: Overview, Swap, Portfolio, Launch, and Token Tools.
- No Telegram bot, Worker, wallet custody, or execution code was modified.


## 2026-10-02 — Mobile navigation cleanup

- Stabilized the compact mobile navigation container after removing obsolete Developer, History, and Orders entries.
- Mobile navigation now has a constrained scroll region with hidden scrollbar chrome and no inherited horizontal overscroll behavior.
- Specialized Mint, Burn, Lock, and Unlock writes remain intentionally gated because the repository does not contain a verified standard contract interface for those operations; no guessed write methods were added.
- No Telegram bot, Worker, wallet custody, or execution code was modified.


## 2026-10-02 — Complete light theme

- Added a full light-mode palette for the terminal rather than only changing the theme toggle label.
- Light mode covers the shell, sidebar/navigation, cards, forms, selects, tables, status text, code output, drop zones, buttons, and swap-related surfaces.
- Theme preference remains persisted through the existing `neyro-theme` localStorage key and `data-theme` attribute.
- No Telegram bot, Worker, wallet custody, or execution code was modified.


## 2026-10-02 — Mobile navigation section picker

- Replaced the clipped horizontal mobile navigation with a native section picker.
- Desktop keeps the grouped sidebar navigation; mobile uses the same NAV_GROUPS source without overflowing or truncating labels.
- The selected terminal view stays synchronized with the mobile picker.
- No Telegram bot, Worker, wallet custody, or execution code was modified.


## 2026-10-02 — Light theme and remaining-page UI pass

- Added a final terminal typography/theme layer with larger body, navigation, form and secondary text for desktop and mobile readability.
- Light mode now uses a subtle layered palette: page background, slightly tinted sidebar, white cards, soft raised panels and restrained borders/shadows instead of a flat white surface.
- Form focus, buttons, tables, drop zones, code output and mobile section picker receive matching light-mode states.
- Upgraded the remaining gated pages (Create token, Mint, Burn, Lock, Unlock, Developer write/builder and token-operation history) with explicit integration requirements instead of empty placeholder cards.
- Create token links to the already implemented NEARly launch surface; no unverified token factory transaction was added.
- No guessed token-operation contract methods were introduced.
- No Telegram bot, Worker, wallet custody, or production signer code was modified.


## 2026-10-02 — Token tools protocol pass

- Create Token now explicitly routes to the implemented NEARly launch surface instead of pretending a generic token factory exists.
- Mint is not exposed because NEARly launch tokens have a fixed 1B supply and no post-launch mint method.
- Burn is a real browser-wallet operation for completed NEARly launch tokens: the web terminal verifies the token with `nearlytrade.near.get_launch_by_token`, reads `ft_metadata` and `ft_balance_of`, validates the exact base-unit amount, then signs the token's `burn` function call.
- Lock/Unlock are not exposed as arbitrary token operations. NEARly's locker accounts hold launch liquidity positions and do not provide a general user-token lock/unlock workflow.
- No generic unverified contract write was introduced.
- No Telegram bot or Worker code was modified.


## 2026-10-02 — Tablet/mobile layout correction

- At widths up to 900px the terminal switches from a fixed sidebar layout to a compact top navigation with the existing section picker.
- The wallet sidebar card is hidden at tablet/mobile widths so the actual terminal content gets the full viewport.
- Tablet views use a single-column card grid; smaller screens stack module details and hero state cleanly.
- This corrects the narrow 768px browser layout shown during the light-mode review.

## 18. Generic token mint tool

The Mint terminal is intentionally **not coupled to NEARly**.

The web UI first verifies a live fungible-token surface by reading:
- `ft_metadata` and requiring `spec = ft-1.0.0`;
- `ft_total_supply`;
- `ft_balance_of` for the connected account;
- `storage_balance_of` for the selected recipient when the token exposes NEP-145.

Minting itself is not part of the NEP-141 core interface. The UI therefore treats the mint method as contract-specific instead of falsely claiming that every NEP-141 token has a standard mint call.

The default mint interface is custom because no mint signature is guaranteed by NEP-141. The UI also provides clearly-labelled common implementation patterns:
- `ft_mint({ receiver_id, amount })`;
- `mint({ receiver_id, amount })`;
- `mint({ account_id, amount })`.
These patterns are not presented as verified capabilities. The user must verify the token's own documentation/source and access-control model before signing.

Amounts are converted to exact base units with `bigint`. The transaction preview shows the contract, method, recipient, amount, attached deposit and gas before browser signing.

The connected wallet remains the only signer. NEARly-specific fixed-supply behavior is kept inside the NEARly launch/burn surfaces and does not gate generic NEAR token development.

## 33. 2026-10-02 — Mint tool workflow correction

The Mint surface was rebuilt around the actual token-tool use case rather than NEARly launch behavior.

- Mint is for additional supply on an already deployed token whose signer controls the token's mint authority.
- The page now exposes the mint workflow immediately: token contract, recipient, amount, live supply before/after, mint method, transaction settings and a final signing action.
- The page does not claim that NEP-141 defines minting. NEP-141 standardizes the fungible-token surface; mint authority and method remain contract-specific.
- Common mint(receiver_id, amount) and mint(account_id, amount) patterns are presets only and must match the token's actual contract.
- NEARly remains a separate launch surface; its fixed-supply launch model must not constrain normal NEP-141 token tooling.
- The next infrastructure requirement for Neyro's own generic token-creation flow is a verified Neyro token factory/implementation with an explicit mint-authority model. The UI must not invent a factory address or contract method until that on-chain interface is deployed and verified.

Research basis: NEP-141, NEAR's official FT examples, NEAR factory examples, Smithii's NEAR Token Creator/Manager, and Smithii's NEAR liquidity tooling.


## 2026-10-02 — Mint confirmation UX checkpoint

The generic Mint surface now keeps the submitted mint amount visible after signing and does not immediately re-read token state.

This avoids presenting a just-submitted transaction as already reflected in `ft_total_supply` before finality. After submission, the UI shows the transaction hash and a deliberate **Reload token state** action so the user can re-read on-chain supply/balance after the transaction is final.

No new token tool or protocol surface was added. This is a usability/safety clarification around the existing contract-specific mint workflow.


## 2026-10-02 — Generic Create Token UX checkpoint

The `Create token` route now represents the generic developer-owned token workflow separately from the NEARly launchpad. The form captures token name, symbol, decimals, initial supply, initial recipient and an optional metadata reference, then shows a deployment review.

Deployment remains intentionally disabled until Neyro has a verified generic NEP-141 token-factory contract address and exact call interface. No factory address, authority model, fee, or contract method is invented in the web UI. This follows the observed token-creator pattern of separating token identity/supply configuration from launchpad-specific flows while keeping the actual deployment contract as the source of truth.

## 2026-10-02 — Navigation and generic token boundary checkpoint

The visible navigation now treats **Mint** as the generic fresh-token creation flow. **Launch NEARly token** is the separate NEARly launch mechanism. Token Tools contains operational tools such as Burn, Lock, Unlock, Airdrop and Bulk Transfer.

The generic Create Token surface remains a deployment configuration/review form. It does not claim that NEP-141 itself defines token deployment, mint authority, or a factory. Deployment stays gated until Neyro has a verified token implementation/factory and exact initialization interface.

## 2026-10-02 — Web Terminal CI verification

Commit `0c084d9283a912800369a76f1bc96fa9dbfffed3` completed Web Terminal CI run **#311** successfully.

Verified checks:
- `npm install --no-audit --no-fund`
- `npm run typecheck`
- `npm test`
- `npm run build`

The latest selector typing correction is therefore CI-verified. This does not replace real-wallet/testnet execution testing; those remain release gates.

Telegram bot and Worker code remain untouched.
## 2026-10-02 — Product terminology correction: Mint creates a fresh token

Neyro's product specification defines **Mint** as creation of a brand-new token, not increasing the supply of an already deployed token.

The Web Terminal now reflects that terminology:
- **Mint** is the fresh-token creation surface.
- It collects token identity, decimals, initial supply, initial recipient and metadata reference.
- **NEARly Launch** remains a separate launch mechanism.
- There is no separate **Create token** navigation item.
- The previous existing-token mint-call UI is no longer exposed as the Mint product surface.

The fresh-token transaction remains gated until Neyro has a verified generic token implementation/factory and exact on-chain initialization interface. No guessed contract method or address was introduced.

## 2026-10-02 — Token Locker calendar UI

The Lock route now has a professional locker-oriented interface with a modern calendar/date-time selector for the unlock schedule. The calendar supports month navigation, disabled past dates, Today selection, and time selection.

The interface is still execution-gated because the web branch does not have a verified generic token-locker contract/interface. It must not imply that a locker was created or that token balances/lockers exist when no live protocol data has been loaded.


## 2026-10-02 — Mint creation options

The Mint UI now includes:
- token logo upload with PNG/JPG/WEBP validation and a 2 MB client-side limit;
- description and metadata reference fields;
- mint-authority policy selection: retain authority or request revocation after initial supply;
- optional buy/sell tax configuration.

These are configuration surfaces only until the generic token implementation/factory is verified. Mint-authority revocation and buy/sell tax are implementation-specific and are not claimed as NEP-141 capabilities. No unverified transaction method is exposed.

- Added freeze-authority and metadata-authority policy controls to the Mint UI. These remain implementation-specific and are not presented as NEP-141 guarantees.


## 2026-10-02 — Full web-terminal audit checkpoint

Audit scope: PR #26, branch `web-terminal-2026-10-02`, all web source modules, tests, CI workflow, navigation/routing, execution state machine, browser wallet boundary, NEAR RPC/FT helpers, NEARly adapter, token-tool fee/sponsorship modules, and Cloudflare Pages configuration.

Verified:
- PR #26 remains open/draft and its changed files are confined to `web/**` plus `.github/workflows/web-ci.yml`.
- Latest CI for `db3ac34611eba2cdb268f5c24539915de8992d5f`: Web Terminal CI #349 and general CI #573 both passed.
- Cloudflare production deployment for that commit completed build and deploy successfully.
- Browser wallet signing is isolated behind the WebWalletConnector boundary.
- Campaign state is persisted locally and unknown/submitted batches are blocked from blind retry.
- NEAR RPC reads use finality.
- Mint remains a UI/configuration surface until a verified generic token implementation/factory exists.

Open release risks identified by the audit:
1. Generic Mint execution is not production-ready because there is no verified Neyro token factory/implementation and no exact deployment ABI in this branch.
2. Token tax, freeze authority, metadata authority and mint-authority revocation are configuration UI only until the token implementation defines their exact semantics.
3. Bulk transfer now preflights every validated recipient's NEP-145 registration with bounded concurrency and blocks unregistered/unknown recipients. The missing piece is a persisted in-terminal registration transaction using the token's verified storage_balance_bounds and storage_deposit interface.
4. The bulk-transfer parser still materializes parsed recipient rows in browser memory. Million-wallet scale is not yet proven.
5. Burn post-submit state was corrected: the UI no longer immediately reloads token state before finality; the user explicitly reloads token state after the submitted transaction.
6. Liquidity creation/management is not yet implemented in the web terminal. This is a product gap for developers who want to create a generic token and then make it tradable.
7. The historical Mint/Create Token notes above are retained as implementation history; the current navigation/product semantics are the authoritative definition: **Mint creates a fresh token** and NEARly is a separate launch mechanism.


## 2026-10-02 — Recipient registration preflight checkpoint

- Added a bounded-concurrency NEP-145 recipient registration audit to bulk-transfer preflight.
- Neyro now distinguishes registered recipients, unregistered recipients, and tokens where the standard storage API cannot be verified.
- Start Airdrop remains blocked until every validated recipient is registered and the storage API is verifiable.
- The preflight does not guess a storage deposit and does not perform registration itself.
- The next implementation stage is a dedicated persisted registration flow using the token's live storage_balance_bounds and standard storage_deposit interface.
- This is a safety improvement, not a claim of million-wallet readiness; the current browser planner still retains parsed rows in memory.
- Telegram bot and Worker code remain untouched.


## 2026-10-02 — Recipient registration execution checkpoint

The web terminal now has a dedicated NEP-145 recipient-registration execution path:

- reads the token's live `storage_balance_bounds`;
- uses the reported `min` storage deposit rather than guessing a fee;
- allows the connected browser wallet to pay storage for recipient accounts;
- uses `registration_only: true` so excess attached storage is not intentionally accumulated;
- batches at most 10 registration calls per transaction with 30 TGas per call, keeping the planned registration transaction at or below 300 TGas;
- persists registration sessions in IndexedDB;
- records pending/signing/submitted/success/failed/unknown states;
- requires reconciliation before retrying an unknown/submitted registration transaction;
- requires a fresh registration preflight before the airdrop itself can proceed.

This is intentionally separate from the Telegram bot and does not expose Telegram signer material to the browser.

NEP-145 defines `storage_balance_bounds` as the source of the minimum/maximum storage amounts and `storage_deposit` as the payable registration method. citeturn0search0

Remaining release work:
- verify the flow against several real NEP-141 contracts on mainnet;
- add automated browser-wallet/testnet execution coverage;
- continue memory-bounded planning work for very large recipient sets;
- do not claim million-wallet readiness from the registration flow alone.
