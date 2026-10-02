import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { NearRpcClient } from "./near/rpc";
import { preflightSenders, type CampaignPreflight } from "./preflight";
import { createMyNearWalletConnector } from "./wallet/selector";
import type { WebWalletConnector } from "./wallet/connector";
import { allocateRecipientsDetailed, type ValidRecipient } from "./airdrop-core";
import { executeAirdrop, reconcileCampaign } from "./execution/executor";
import { IndexedDbCampaignStore } from "./campaign/storage";
import type { Campaign } from "./campaign/model";
import { campaignResultsCsv } from "./campaign/export";
import { getFtMetadata, type FtMetadata } from "./near/ft";
import {
  OverviewView,
  CampaignHistoryView,
  PortfolioView,
  ContractInspectorView,
  PersistedTransactionsView,
  TerminalModuleView,
  TokenBurnView,
  TokenLockView,
  CreateTokenView,
  NearlyLaunchView,
  SwapView
} from "./terminal-views";

type Row = {
  line: number;
  wallet: string;
  amount: string;
  valid: boolean;
  error?: string;
  base?: bigint;
};

type Plan = {
  rows: Row[];
  valid: number;
  invalid: number;
  duplicates: number;
  total: bigint;
  batches: number;
};

type NavGroup = {
  label?: string;
  items: string[];
};

const NAV_GROUPS: NavGroup[] = [
  { label: "WORKSPACE", items: ["Overview"] },
  { label: "TRADE", items: ["Swap", "Portfolio"] },
  { label: "LAUNCH", items: ["Launch NEARly token"] },
  { label: "TOKEN", items: ["Mint"] },
  { label: "TOKEN TOOLS", items: ["Burn", "Lock", "Unlock", "Airdrop", "Bulk Transfer"] },
];

const ACCOUNT_ID =
  /^(?=.{2,64}$)(?:[a-z\d]+(?:[-_][a-z\d]+)*\.)*[a-z\d]+(?:[-_][a-z\d]+)*$/;

function splitLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (c === delimiter && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += c;
    }
  }

  values.push(value.trim());
  return values;
}

function delimiterFor(line: string): string {
  const options = [",", "\t", ";"];
  return options.reduce((best, current) =>
    splitLine(line, current).length > splitLine(line, best).length ? current : best
  );
}

function amountToBase(value: string, decimals: number): bigint {
  const clean = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(clean)) throw new Error("invalid amount");
  const parts = clean.split(".");
  const fraction = parts[1] ?? "";
  if (fraction.length > decimals) throw new Error("too many decimals");
  const base =
    BigInt(parts[0]) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (base <= 0n) throw new Error("amount must be greater than zero");
  return base;
}

function formatBase(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? whole.toString() + "." + fraction : whole.toString();
}

async function* lines(file: File): AsyncGenerator<string> {
  if (!file.stream || typeof TextDecoderStream === "undefined") {
    const text = await file.text();
    for (const line of text.split(/\r?\n/)) yield line;
    return;
  }

  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += next.value;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) yield part;
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

function makeRow(
  line: number,
  wallet: string,
  amount: string,
  decimals: number,
  seen: Set<string>
): Row {
  if (!ACCOUNT_ID.test(wallet)) {
    return { line, wallet, amount, valid: false, error: "invalid NEAR account" };
  }
  if (seen.has(wallet)) {
    return { line, wallet, amount, valid: false, error: "duplicate wallet" };
  }

  try {
    const base = amountToBase(amount, decimals);
    seen.add(wallet);
    return { line, wallet, amount, valid: true, base };
  } catch (error) {
    return {
      line,
      wallet,
      amount,
      valid: false,
      error: error instanceof Error ? error.message : "invalid amount"
    };
  }
}

async function parseFile(
  file: File,
  decimals: number,
  defaultAmount: string,
  progress: (value: number) => void
): Promise<Plan> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  let valid = 0;
  let invalid = 0;
  let duplicates = 0;
  let total = 0n;

  if (file.name.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(await file.text()) as unknown;
    if (!Array.isArray(parsed)) throw new Error("JSON must contain an array");

    for (let i = 0; i < parsed.length; i += 1) {
      const item = parsed[i];
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const wallet = String(
        record.wallet ?? record.address ?? record.account ?? record.account_id ?? ""
      ).trim().toLowerCase();
      const amount = String(record.amount ?? defaultAmount).trim();
      const row = makeRow(i + 1, wallet, amount, decimals, seen);
      rows.push(row);
      if (row.valid) {
        valid += 1;
        total += row.base!;
      } else {
        invalid += 1;
        if (row.error === "duplicate wallet") duplicates += 1;
      }
      if (i % 1000 === 0) progress(i + 1);
    }
  } else {
    let lineNumber = 0;
    let first = true;
    let delimiter = ",";

    for await (const raw of lines(file)) {
      lineNumber += 1;
      const line = raw.trim();
      if (!line) continue;

      if (first) {
        first = false;
        delimiter = delimiterFor(line);
        const fields = splitLine(line, delimiter).map((v) =>
          v.toLowerCase().replace(/[ _-]/g, "")
        );
        const isHeader = fields.some((v) =>
          ["wallet", "address", "account", "accountid", "recipient", "receiver"].includes(v)
        );
        if (isHeader) continue;
      }

      const fields = splitLine(line, delimiter);
      const wallet = (fields[0] ?? "").trim().toLowerCase();
      const amount = (fields[1] ?? defaultAmount).trim();
      const row = makeRow(lineNumber, wallet, amount, decimals, seen);
      rows.push(row);

      if (row.valid) {
        valid += 1;
        total += row.base!;
      } else {
        invalid += 1;
        if (row.error === "duplicate wallet") duplicates += 1;
      }

      if (lineNumber % 1000 === 0) progress(lineNumber);
    }
  }

  progress(rows.length);
  return { rows, valid, invalid, duplicates, total, batches: Math.ceil(valid / 100) };
}

function App() {
  const [activeView, setActiveView] = useState("Overview");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("neyro-theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [wallet, setWallet] = useState<WebWalletConnector | null>(null);
  const [accountId, setAccountId] = useState("");
  const [walletBusy, setWalletBusy] = useState(false);

  const [token, setToken] = useState("");
  const [decimals, setDecimals] = useState("");
  const [defaultAmount, setDefaultAmount] = useState("");
  const [tokenMetadata, setTokenMetadata] = useState<FtMetadata | null>(null);
  const [tokenMetadataBusy, setTokenMetadataBusy] = useState(false);
  const [senders, setSenders] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [message, setMessage] = useState("Upload a recipient file to build the campaign.");
  const [preflight, setPreflight] = useState<CampaignPreflight | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [executionCampaign, setExecutionCampaign] = useState<Campaign | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  const campaignStore = useMemo(() => new IndexedDbCampaignStore(), []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("neyro-theme", theme); } catch {}
  }, [theme]);

  useEffect(() => {
    void campaignStore.list()
      .then((storedCampaigns) => {
        setCampaigns(storedCampaigns);
        const latest = [...storedCampaigns].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (latest) setExecutionCampaign(latest);
      })
      .catch(() => {
        // IndexedDB may be unavailable in private/restricted browser contexts.
      });
  }, [campaignStore]);

  const senderList = useMemo(
    () => senders.split(/\r?\n/).map((v) => v.trim().toLowerCase()).filter(Boolean),
    [senders]
  );

  function syncCampaign(nextCampaign: Campaign) {
    setExecutionCampaign(nextCampaign);
    setCampaigns((current) => {
      const withoutCurrent = current.filter((campaign) => campaign.id !== nextCampaign.id);
      return [...withoutCurrent, nextCampaign];
    });
  }

  async function loadTokenMetadata() {
    const contract = token.trim().toLowerCase();
    if (!contract) {
      setMessage("Enter a token contract first.");
      return;
    }

    setTokenMetadataBusy(true);
    setTokenMetadata(null);
    setPreflight(null);
    try {
      const metadata = await getFtMetadata(new NearRpcClient(), contract);
      setTokenMetadata(metadata);
      setDecimals(String(metadata.decimals));
      setMessage(`${metadata.symbol} · ${metadata.name} loaded from NEAR mainnet.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load token metadata.");
    } finally {
      setTokenMetadataBusy(false);
    }
  }

  async function connectWallet() {
    setWalletBusy(true);
    try {
      const connector = wallet ?? await createMyNearWalletConnector();
      const account = await connector.connect();
      setWallet(connector);
      setAccountId(account.accountId);
      setMessage("Browser wallet connected. Signing remains gated by campaign safety checks.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not connect browser wallet");
    } finally {
      setWalletBusy(false);
    }
  }

  async function disconnectWallet() {
    if (!wallet) return;
    setWalletBusy(true);
    try {
      await wallet.disconnect();
      setAccountId("");
      setWallet(null);
      setMessage("Browser wallet disconnected.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not disconnect browser wallet");
    } finally {
      setWalletBusy(false);
    }
  }

  async function runPreflight() {
    if (!token.trim()) {
      setMessage("Enter a token contract before running sender preflight.");
      return;
    }
    if (!plan) {
      setMessage("Upload and validate a recipient file before running sender preflight.");
      return;
    }
    if (senderList.length === 0) {
      setMessage("Add at least one sender account before running sender preflight.");
      return;
    }

    setPreflightBusy(true);
    setPreflight(null);
    setMessage("Reading fresh sender balances from NEAR mainnet…");
    try {
      const result = await preflightSenders(
        new NearRpcClient(),
        token.trim(),
        senderList,
        plan.total
      );
      setPreflight(result);
      setMessage(
        result.enoughTokenBalance
          ? "Preflight passed for aggregate token balance. Execution remains locked."
          : "Preflight failed: sender pool does not cover the campaign total."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sender preflight failed");
    } finally {
      setPreflightBusy(false);
    }
  }

  async function reconcileExecution() {
    if (!executionCampaign) return;
    setExecutionBusy(true);
    setMessage(`Reconciling campaign ${executionCampaign.id}…`);
    try {
      const campaign = await reconcileCampaign(
        executionCampaign.id,
        campaignStore,
        new NearRpcClient(),
        ({ campaign: nextCampaign }) => syncCampaign({
          ...nextCampaign,
          batches: nextCampaign.batches.map((item) => ({ ...item }))
        })
      );
      syncCampaign(campaign);
      setMessage(
        campaign.status === "completed"
          ? "Campaign reconciliation confirmed completion."
          : "Reconciliation finished. Review batch states before retrying."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Campaign reconciliation failed");
    } finally {
      setExecutionBusy(false);
    }
  }

  async function resumeCampaign() {
    if (!wallet || !executionCampaign) {
      setMessage("Connect the browser wallet before resuming a campaign.");
      return;
    }

    setExecutionBusy(true);
    setMessage(`Resuming campaign ${executionCampaign.id} from persisted state…`);

    try {
      const grouped = new Map<string, ValidRecipient[]>();
      for (const batch of executionCampaign.batches) {
        const recipients = grouped.get(batch.senderId) ?? [];
        for (const recipient of batch.recipients) {
          recipients.push({
            line: 0,
            wallet: recipient.wallet,
            amountBase: BigInt(recipient.amountBase)
          });
        }
        grouped.set(batch.senderId, recipients);
      }

      const allocations = [...grouped.entries()].map(([senderId, recipients]) => ({
        senderId,
        recipients,
        totalAmount: recipients.reduce((sum, recipient) => sum + recipient.amountBase, 0n)
      }));

      const result = await executeAirdrop({
        tokenContract: executionCampaign.tokenContract,
        decimals: executionCampaign.decimals,
        allocations,
        sourceFingerprint: executionCampaign.sourceFingerprint,
        wallet,
        rpc: new NearRpcClient(),
        store: campaignStore,
        onProgress: ({ campaign, batch }) => {
          syncCampaign({ ...campaign, batches: campaign.batches.map((item) => ({ ...item })) });
          setMessage(
            batch.status === "success"
              ? `Confirmed batch ${batch.id}.`
              : `Batch ${batch.id}: ${batch.status}.`
          );
        }
      });

      syncCampaign(result.campaign);
      setMessage(
        result.campaign.status === "completed"
          ? "Persisted campaign completed successfully."
          : "Campaign execution paused safely."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Campaign resume stopped safely.");
    } finally {
      setExecutionBusy(false);
    }
  }

  async function startAirdrop() {
    if (!wallet || !accountId) {
      setMessage("Connect the browser wallet before starting execution.");
      return;
    }
    if (!plan || plan.invalid > 0) {
      setMessage("Resolve all invalid or duplicate recipient rows before execution.");
      return;
    }
    if (!token.trim() || senderList.length === 0) {
      setMessage("Enter the token contract and at least one sender account.");
      return;
    }

    setExecutionBusy(true);
    setMessage("Refreshing sender balances and building the execution plan…");

    try {
      const fresh = await preflightSenders(
        new NearRpcClient(),
        token.trim(),
        senderList,
        plan.total
      );

      if (fresh.decimals !== Number(decimals)) {
        throw new Error(
          `Token reports ${fresh.decimals} decimals, but the campaign was parsed with ${decimals}. Re-parse the file with the token's actual decimals.`
        );
      }
      if (!fresh.enoughTokenBalance) {
        throw new Error("Fresh sender balances do not cover the campaign total.");
      }
      if (fresh.senders.some((sender) => sender.storage === "not-registered")) {
        throw new Error("At least one sender is not registered with the token contract.");
      }

      const recipients: ValidRecipient[] = plan.rows
        .filter((row): row is Row & { base: bigint } => row.valid && row.base !== undefined)
        .map((row) => ({
          line: row.line,
          wallet: row.wallet,
          amountBase: row.base
        }));

      const allocations = allocateRecipientsDetailed(recipients, fresh.senders);
      const sourceFingerprint = [
        token.trim().toLowerCase(),
        String(fresh.decimals),
        senderList.join(","),
        recipients.map((recipient) => `${recipient.line}:${recipient.wallet}:${recipient.amountBase}`).join("|")
      ].join("::");

      const result = await executeAirdrop({
        tokenContract: token.trim().toLowerCase(),
        decimals: fresh.decimals,
        allocations,
        sourceFingerprint,
        wallet,
        rpc: new NearRpcClient(),
        store: campaignStore,
        onProgress: ({ campaign, batch }) => {
          setExecutionCampaign({ ...campaign, batches: campaign.batches.map((item) => ({ ...item })) });
          setMessage(
            batch.status === "success"
              ? `Confirmed batch ${batch.id}.`
              : `Batch ${batch.id}: ${batch.status}.`
          );
        }
      });

      setExecutionCampaign(result.campaign);
      setMessage(`Campaign ${result.campaignId} completed successfully.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Airdrop execution stopped safely.");
    } finally {
      setExecutionBusy(false);
    }
  }

  function exportCampaignResults() {
    if (!executionCampaign) return;

    const csv = campaignResultsCsv(executionCampaign);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `neyro-campaign-${executionCampaign.id}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage(`Exported ${executionCampaign.recipientCount.toLocaleString()} campaign results.`);
  }

  async function upload(file: File) {
    if (!Number.isInteger(Number(decimals)) || Number(decimals) < 0 || Number(decimals) > 24) {
      setMessage("Load the token metadata first so Neyro can use the verified token decimals.");
      return;
    }

    setBusy(true);
    setPlan(null);
    setPreflight(null);
    setFileName(file.name);
    setProcessed(0);
    setMessage("Streaming and validating recipients…");

    try {
      const result = await parseFile(file, Number(decimals), defaultAmount, setProcessed);
      setPlan(result);
      setMessage(
        result.invalid
          ? "Validation finished. Fix invalid rows before execution."
          : "Validation finished. Campaign is ready for the execution layer."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not parse file");
    } finally {
      setBusy(false);
    }
  }

  const preview = plan?.rows.filter((row) => row.valid).slice(0, 12) ?? [];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/neyro-logo.svg" alt="" aria-hidden="true" />
          <div><strong>NEYRO</strong><small>TERMINAL</small></div>
        </div>

        <nav className="nav-groups" aria-label="Terminal navigation">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label ?? "root"}>
              {group.label && <div className="nav-label">{group.label}</div>}
              {group.items.map((item) => (
                <button
                  key={item}
                  className={activeView === item ? "nav active" : "nav"}
                  onClick={() => setActiveView(item)}
                >
                  <span className="nav-dot" />
                  <span>{item}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <label className="mobile-nav-wrap">
          <span className="sr-only">Terminal section</span>
          <select
            className="mobile-nav"
            value={activeView}
            onChange={(event) => setActiveView(event.target.value)}
            aria-label="Terminal section"
          >
            {NAV_GROUPS.map((group) => (
              <optgroup key={group.label ?? "root"} label={group.label ?? "Terminal"}>
                {group.items.map((item) => <option key={item} value={item}>{item}</option>)}
              </optgroup>
            ))}
          </select>
        </label>

        <div className="sidebar-bottom">
          <div className="wallet-box">
            <span>WEB WALLET</span>
            <strong>{accountId || "Not connected"}</strong>
            <small>Browser-wallet custody stays separate from Telegram signing.</small>
            {accountId ? (
              <button onClick={() => void disconnectWallet()} disabled={walletBusy}>
                {walletBusy ? "Working…" : "Disconnect"}
              </button>
            ) : (
              <button onClick={() => void connectWallet()} disabled={walletBusy}>
                {walletBusy ? "Connecting…" : "Connect wallet"}
              </button>
            )}
          </div>

        </div>
      </aside>

      <main>
        <header>
          <div>
            <span className="eyebrow">NEAR MAINNET</span>
            <h1>{activeView}</h1>
          </div>
          <div className="header-actions">
            <button className="theme-toggle" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}>
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            {accountId ? (
              <>
                <span className="account-pill">{accountId}</span>
                <button onClick={() => void disconnectWallet()} disabled={walletBusy}>
                  {walletBusy ? "Working…" : "Disconnect"}
                </button>
              </>
            ) : (
              <button onClick={() => void connectWallet()} disabled={walletBusy}>
                {walletBusy ? "Connecting…" : "Connect wallet"}
              </button>
            )}
          </div>
        </header>

        {activeView === "Overview" ? (
          <OverviewView
            accountId={accountId}
            campaigns={campaigns}
            tokenSymbol={tokenMetadata?.symbol}
          />
        ) : activeView === "Portfolio" ? (
          <PortfolioView accountId={accountId} tokenContract={token} />
        ) : activeView === "Swap" ? (
          <SwapView accountId={accountId} wallet={wallet} />
        ) : activeView === "Launch NEARly token" ? (
          <NearlyLaunchView accountId={accountId} wallet={wallet} />
        ) : activeView === "Contract Inspector" ? (
          <ContractInspectorView />
        ) : activeView === "Transactions" ? (
          <PersistedTransactionsView campaigns={campaigns} />
        ) : activeView === "Burn" ? (
          <TokenBurnView accountId={accountId} wallet={wallet} />
        ) : activeView === "Lock" ? (
          <TokenLockView accountId={accountId} />
        ) : activeView === "Mint" ? (
          <CreateTokenView accountId={accountId} />
        ) : activeView === "Airdrop Campaigns" ? (
          <CampaignHistoryView
            campaigns={campaigns}
            onOpen={(campaign) => {
              setExecutionCampaign(campaign);
              setActiveView("Bulk Transfer");
              setMessage(`Loaded campaign ${campaign.id} from local history.`);
            }}
          />
        ) : activeView === "Bulk Transfer" || activeView === "Airdrop" ? (
          <section className="grid">
            <div className="card hero">
              <div>
                <span className="eyebrow">{activeView === "Airdrop" ? "NEP-141 / AIRDROP" : "NEP-141 / BULK TRANSFER"}</span>
                <h2>Build and execute a multi-sender transfer.</h2>
                <p>
                  Load a verified token, add senders and recipients, then run fresh preflight checks before the browser wallet is asked to sign.
                </p>
              </div>
              <div className="hero-state">
                <span className={accountId ? "status-dot live" : "status-dot"} />
                <span>{accountId ? "Wallet connected" : "Wallet not connected"}</span>
              </div>
            </div>

            <div className="card token-card">
              <div className="section-head">
                <div>
                  <span className="eyebrow">TOKEN</span>
                  <h3>{tokenMetadata ? `${tokenMetadata.symbol} · ${tokenMetadata.name}` : "Load a NEP-141 token"}</h3>
                </div>
                <button onClick={() => void loadTokenMetadata()} disabled={tokenMetadataBusy || !token.trim()}>
                  {tokenMetadataBusy ? "Loading…" : "Load token"}
                </button>
              </div>
              <input
                value={token}
                onChange={(e) => { setToken(e.target.value); setTokenMetadata(null); setDecimals(""); setPreflight(null); }}
                placeholder="contract.near"
                spellCheck={false}
              />
              <div className="two">
                <div>
                  <label>Verified decimals</label>
                  <input value={decimals} readOnly placeholder="—" />
                </div>
                <div>
                  <label>Default amount <span className="optional">optional</span></label>
                  <input value={defaultAmount} onChange={(e) => setDefaultAmount(e.target.value)} placeholder={tokenMetadata ? "Used when file has no amount" : "Load token first"} disabled={!tokenMetadata} />
                </div>
              </div>
              {tokenMetadata && (
                <div className="token-meta">
                  <span>{tokenMetadata.spec}</span>
                  <span>{tokenMetadata.decimals} decimals</span>
                  {tokenMetadata.reference && <span>metadata linked</span>}
                </div>
              )}
            </div>

            <div className="card">
              <div className="section-head">
                <div>
                  <span className="eyebrow">SENDER POOL</span>
                  <h3>{senderList.length ? `${senderList.length} sender${senderList.length === 1 ? "" : "s"} configured` : "Add signing accounts"}</h3>
                </div>
                {senderList.length > 0 && <span className="live-label">On-chain balances</span>}
              </div>
              <textarea value={senders} onChange={(e) => setSenders(e.target.value)} rows={4} placeholder={"Paste sender account IDs, one per line"} />
              <small>Fresh token, storage and NEAR balances are read before execution.</small>
            </div>

            <div className="card full">
              <div className="row-title">
                <div><label>Recipients</label><h3>{fileName || "No file selected"}</h3></div>
                <span className="muted">CSV / TXT / JSON</span>
              </div>
              <label className="drop">
                <input type="file" accept=".csv,.txt,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
                <b>Upload recipient file</b>
                <span>CSV/TXT uses streaming parsing for large lists.</span>
              </label>
              {busy && <div className="progress"><div /></div>}
              <p className="message">{message}</p>
            </div>

            {plan && (
              <>
                <div className="stats">
                  <Stat name="Recipients" value={plan.valid.toLocaleString()} />
                  <Stat name="Invalid" value={plan.invalid.toLocaleString()} />
                  <Stat name="Duplicates" value={plan.duplicates.toLocaleString()} />
                  <Stat name="Batches" value={plan.batches.toLocaleString()} />
                </div>

                <div className="card">
                  <div className="row-title">
                    <div><span className="eyebrow">CAMPAIGN TOTAL</span><h2>{formatBase(plan.total, Number(decimals))}</h2></div>
                    <span className={plan.invalid ? "warning" : "ready"}>{plan.invalid ? "Needs review" : "Ready"}</span>
                  </div>
                  <p className="muted">Token: {token || "—"} · Sender accounts: {senderList.length} · Decimals: {decimals || "—"}</p>
                </div>

                <div className="card full">
                  <div className="row-title">
                    <div><span className="eyebrow">READ-ONLY PREFLIGHT</span><h3>Fresh sender balances</h3></div>
                    <button
                      onClick={() => void runPreflight()}
                      disabled={preflightBusy || Boolean(plan.invalid) || !token.trim() || senderList.length === 0}
                    >
                      {preflightBusy ? "Checking…" : "Check balances"}
                    </button>
                  </div>
                  {preflight ? (
                    <>
                      <p className={preflight.enoughTokenBalance ? "ready" : "warning"}>
                        {preflight.enoughTokenBalance ? "Aggregate token balance is sufficient." : "Aggregate token balance is insufficient."}
                      </p>
                      <p className="muted">
                        Available: {preflight.totalTokenBalance.toString()} base units · Required: {preflight.totalRequired.toString()} base units
                      </p>
                      <div className="table-wrap">
                        <table>
                          <thead><tr><th>Sender</th><th>Token</th><th>NEAR</th><th>Storage</th></tr></thead>
                          <tbody>{preflight.senders.map((sender) => (
                            <tr key={sender.senderId}>
                              <td>{sender.senderId}</td>
                              <td>{sender.tokenBalance.toString()}</td>
                              <td>{sender.nativeBalance.toString()}</td>
                              <td className={sender.storage === "registered" ? "ready" : "warning"}>{sender.storage}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                      <small>Read-only. No transaction has been signed or broadcast.</small>
                    </>
                  ) : (
                    <p className="muted">Run this after entering the token, sender pool and validated recipient file.</p>
                  )}
                </div>

                <div className="card full">
                  <div className="row-title">
                    <div><span className="eyebrow">PREVIEW</span><h3>First {preview.length} valid recipients</h3></div>
                    <button
                      onClick={() => void startAirdrop()}
                      disabled={
                        executionBusy ||
                        !wallet ||
                        !accountId ||
                        Boolean(plan.invalid) ||
                        !preflight?.enoughTokenBalance ||
                        preflight.senders.some((sender) => sender.storage === "not-registered")
                      }
                    >
                      {executionBusy ? "Executing…" : "Start airdrop"}
                    </button>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>#</th><th>Wallet</th><th>Amount</th><th>Status</th></tr></thead>
                      <tbody>{preview.map((row) => (
                        <tr key={row.line + row.wallet}>
                          <td>{row.line}</td><td>{row.wallet}</td><td>{row.amount}</td><td className="ready">Valid</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>

                {executionCampaign && (
                  <div className="card full">
                    <div className="row-title">
                      <div><span className="eyebrow">EXECUTION</span><h3>Campaign progress</h3></div>
                      <div className="header-actions">
                        <button onClick={exportCampaignResults} disabled={executionBusy}>
                          Export CSV
                        </button>
                        {executionCampaign.status !== "completed" &&
                          !executionCampaign.batches.some((batch) =>
                            batch.status === "unknown" || batch.status === "submitted"
                          ) && (
                            <button onClick={() => void resumeCampaign()} disabled={executionBusy || !wallet}>
                              {executionBusy ? "Working…" : "Resume"}
                            </button>
                          )}
                        {(executionCampaign.status === "paused" ||
                          executionCampaign.batches.some((batch) =>
                            batch.status === "unknown" || batch.status === "submitted"
                          )) && (
                          <button onClick={() => void reconcileExecution()} disabled={executionBusy}>
                            {executionBusy ? "Working…" : "Reconcile"}
                          </button>
                        )}
                        <span className={executionCampaign.status === "completed" ? "ready" : "warning"}>
                          {executionCampaign.status}
                        </span>
                      </div>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Batch</th><th>Sender</th><th>Recipients</th><th>Status</th><th>Transaction</th></tr></thead>
                        <tbody>
                          {executionCampaign.batches.map((batch) => (
                            <tr key={batch.id}>
                              <td>{batch.id}</td>
                              <td>{batch.senderId}</td>
                              <td>{batch.actionCount}</td>
                              <td className={batch.status === "success" ? "ready" : batch.status === "failed" ? "warning" : "muted"}>
                                {batch.status}
                              </td>
                              <td>{batch.transactionHash ?? batch.error ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <small>
                      A submitted/unknown batch is never automatically resent. Reconcile it before retrying.
                    </small>
                  </div>
                )}
              </>
            )}
          </section>
        ) : (
          <TerminalModuleView view={activeView} onNavigate={setActiveView} />
        )}

        <footer>
          Web terminal execution is isolated from the Telegram bot. No Telegram handlers, encrypted signer storage,
          Telegram wallet services or Worker entrypoint are imported here.
        </footer>
      </main>
    </div>
  );
}

function Stat({ name, value }: { name: string; value: string }) {
  return <div className="card stat"><span>{name}</span><strong>{value}</strong></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
