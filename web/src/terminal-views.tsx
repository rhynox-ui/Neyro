import { useEffect, useState } from "react";
import type { Campaign } from "./campaign/model";
import { NearRpcClient } from "./near/rpc";
import type { WebWalletConnector } from "./wallet/connector";
import { getNearlyLaunchQuotes, launchNearlyToken, quoteNearlyLaunch, NEARLY_WNEAR, type LaunchForm, type NearlyQuoteAsset, type LaunchCost } from "./protocol/nearly";

function formatNear(yocto: string): string {
  const value = BigInt(yocto);
  const divisor = 10n ** 24n;
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction} NEAR` : `${whole.toString()} NEAR`;
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function statusClass(status: Campaign["status"]): string {
  return status === "completed" ? "ready" : status === "failed" ? "warning" : "muted";
}

export function OverviewView({
  accountId,
  campaigns,
  tokenSymbol
}: {
  accountId: string;
  campaigns: Campaign[];
  tokenSymbol?: string;
}) {
  const [nativeBalance, setNativeBalance] = useState<string | null>(null);
  const [balanceBusy, setBalanceBusy] = useState(false);

  useEffect(() => {
    if (!accountId) {
      setNativeBalance(null);
      return;
    }

    let cancelled = false;
    setBalanceBusy(true);
    void new NearRpcClient().viewAccount(accountId)
      .then((account) => {
        if (!cancelled) setNativeBalance(account.amount);
      })
      .catch(() => {
        if (!cancelled) setNativeBalance(null);
      })
      .finally(() => {
        if (!cancelled) setBalanceBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const completed = campaigns.filter((campaign) => campaign.status === "completed").length;
  const active = campaigns.filter((campaign) => campaign.status === "running" || campaign.status === "paused").length;
  const recipients = campaigns.reduce((sum, campaign) => sum + campaign.recipientCount, 0);
  const latest = [...campaigns].sort((a, b) => b.updatedAt - a.updatedAt)[0];

  return (
    <section className="grid overview">
      <div className="card hero">
        <div>
          <span className="eyebrow">TERMINAL OVERVIEW</span>
          <h2>Real wallet state. Real campaign state.</h2>
          <p>
            Neyro reads the connected browser wallet and locally persisted execution history.
            Nothing on this screen is a demo balance or fabricated transaction.
          </p>
        </div>
        <div className="hero-state">
          <span className={accountId ? "status-dot live" : "status-dot"} />
          <span>{accountId ? "Wallet connected" : "Connect wallet to begin"}</span>
        </div>
      </div>

      <div className="stats">
        <div className="card stat"><span>Network</span><strong>NEAR mainnet</strong></div>
        <div className="card stat"><span>Native balance</span><strong>{balanceBusy ? "Reading…" : nativeBalance ? formatNear(nativeBalance) : "—"}</strong></div>
        <div className="card stat"><span>Campaigns</span><strong>{campaigns.length.toLocaleString()}</strong></div>
        <div className="card stat"><span>Recipients tracked</span><strong>{recipients.toLocaleString()}</strong></div>
      </div>

      <div className="card">
        <div className="row-title">
          <div><span className="eyebrow">EXECUTION HISTORY</span><h3>Campaign state</h3></div>
          <span className="muted">{active.toLocaleString()} active</span>
        </div>
        <div className="overview-list">
          <div><span>Completed campaigns</span><strong>{completed.toLocaleString()}</strong></div>
          <div><span>Active / paused</span><strong>{active.toLocaleString()}</strong></div>
          <div><span>Persisted recipient rows</span><strong>{recipients.toLocaleString()}</strong></div>
          <div><span>Storage</span><strong>Browser IndexedDB</strong></div>
        </div>
      </div>

      <div className="card">
        <div className="row-title">
          <div><span className="eyebrow">LATEST CAMPAIGN</span><h3>{latest ? shortId(latest.id) : "No campaign yet"}</h3></div>
          {latest && <span className={statusClass(latest.status)}>{latest.status}</span>}
        </div>
        {latest ? (
          <div className="overview-list">
            <div><span>Token</span><strong>{tokenSymbol ?? shortId(latest.tokenContract)}</strong></div>
            <div><span>Recipients</span><strong>{latest.recipientCount.toLocaleString()}</strong></div>
            <div><span>Senders</span><strong>{latest.senderIds.length.toLocaleString()}</strong></div>
            <div><span>Batches</span><strong>{latest.batches.length.toLocaleString()}</strong></div>
          </div>
        ) : (
          <p className="muted">Build a campaign from Bulk Transfer and its state will appear here.</p>
        )}
      </div>

      <div className="card full">
        <div className="row-title">
          <div><span className="eyebrow">WALLET BOUNDARY</span><h3>Browser signing only</h3></div>
          <span className={accountId ? "ready" : "muted"}>{accountId ? "connected" : "not connected"}</span>
        </div>
        <p className="muted">
          Telegram wallet custody and Worker services are not exposed to the web terminal.
          {accountId ? ` Connected account: ${accountId}.` : " Connect a browser wallet when you are ready to sign."}
        </p>
      </div>
    </section>
  );
}

export function CampaignHistoryView({
  campaigns,
  onOpen
}: {
  campaigns: Campaign[];
  onOpen: (campaign: Campaign) => void;
}) {
  const sorted = [...campaigns].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <section className="grid overview">
      <div className="card hero">
        <div>
          <span className="eyebrow">PERSISTED CAMPAIGNS</span>
          <h2>Execution history from this browser.</h2>
          <p>
            Campaigns are stored locally so Neyro can resume or reconcile execution after a reload.
            No private keys are stored here.
          </p>
        </div>
        <div className="hero-state"><span className="status-dot live" /><span>{campaigns.length} stored</span></div>
      </div>

      <div className="card full">
        {sorted.length === 0 ? (
          <p className="muted">No campaigns have been created in this browser yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Campaign</th><th>Token</th><th>Recipients</th><th>Batches</th><th>Status</th><th>Updated</th><th /></tr>
              </thead>
              <tbody>
                {sorted.map((campaign) => (
                  <tr key={campaign.id}>
                    <td>{shortId(campaign.id)}</td>
                    <td>{campaign.tokenContract}</td>
                    <td>{campaign.recipientCount.toLocaleString()}</td>
                    <td>{campaign.batches.length.toLocaleString()}</td>
                    <td className={statusClass(campaign.status)}>{campaign.status}</td>
                    <td>{new Date(campaign.updatedAt).toLocaleString()}</td>
                    <td><button onClick={() => onOpen(campaign)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}


export function PortfolioView({
  accountId,
  tokenContract
}: {
  accountId: string;
  tokenContract: string;
}) {
  const [nativeBalance, setNativeBalance] = useState<string | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [tokenMetadata, setTokenMetadata] = useState<{ symbol: string; name: string; decimals: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    if (!accountId) {
      setNativeBalance(null);
      setTokenBalance(null);
      setTokenMetadata(null);
      setError("");
      return;
    }

    setBusy(true);
    setError("");
    const rpc = new NearRpcClient();
    try {
      const account = await rpc.viewAccount(accountId);
      setNativeBalance(account.amount);

      const contract = tokenContract.trim().toLowerCase();
      if (contract) {
        const metadata = await rpc.viewFunction<{ symbol: string; name: string; decimals: number }>(
          contract,
          "ft_metadata"
        );
        const balance = await rpc.viewFunction<string>(contract, "ft_balance_of", {
          account_id: accountId
        });
        if (!/^\d+$/.test(balance)) throw new Error("Token returned an invalid balance.");
        setTokenMetadata(metadata);
        setTokenBalance(BigInt(balance));
      } else {
        setTokenMetadata(null);
        setTokenBalance(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Portfolio read failed.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [accountId, tokenContract]);

  return (
    <section className="grid terminal-page">
      <div className="card hero">
        <div>
          <span className="eyebrow">PORTFOLIO</span>
          <h2>Live holdings from the connected NEAR account.</h2>
          <p>No fabricated token rows or USD valuations. Neyro reads native NEAR and the token contract currently loaded in Bulk Transfer.</p>
        </div>
        <div className="hero-state">
          <span className={accountId ? "status-dot live" : "status-dot"} />
          <span>{accountId ? "Connected" : "Connect wallet"}</span>
        </div>
      </div>

      {!accountId ? (
        <div className="card full empty-state">
          <h3>Connect a browser wallet</h3>
          <p className="muted">Portfolio reads are account-specific and stay read-only.</p>
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="card stat"><span>Account</span><strong className="mono-value">{shortId(accountId)}</strong></div>
            <div className="card stat"><span>NEAR balance</span><strong>{busy && nativeBalance === null ? "Reading…" : nativeBalance ? formatNear(nativeBalance) : "—"}</strong></div>
            <div className="card stat"><span>Loaded token</span><strong>{tokenMetadata?.symbol ?? "—"}</strong></div>
            <div className="card stat"><span>Token balance</span><strong>{tokenBalance !== null && tokenMetadata ? formatTokenBase(tokenBalance, tokenMetadata.decimals) : "—"}</strong></div>
          </div>

          <div className="card full">
            <div className="row-title">
              <div><span className="eyebrow">TOKEN HOLDING</span><h3>{tokenMetadata ? tokenMetadata.name : "No token loaded"}</h3></div>
              <button onClick={() => void refresh()} disabled={busy}>{busy ? "Reading…" : "Refresh"}</button>
            </div>
            {tokenMetadata ? (
              <div className="overview-list">
                <div><span>Contract</span><strong>{tokenContract.trim().toLowerCase()}</strong></div>
                <div><span>Symbol</span><strong>{tokenMetadata.symbol}</strong></div>
                <div><span>Decimals</span><strong>{tokenMetadata.decimals}</strong></div>
                <div><span>Balance</span><strong>{formatTokenBase(tokenBalance ?? 0n, tokenMetadata.decimals)}</strong></div>
              </div>
            ) : (
              <p className="muted">Load a NEP-141 token in Bulk Transfer, then return here to read its balance.</p>
            )}
            {error && <p className="message warning">{error}</p>}
          </div>
        </>
      )}
    </section>
  );
}

function formatTokenBase(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

export function ContractInspectorView() {
  const [contract, setContract] = useState("");
  const [method, setMethod] = useState("");
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function inspect() {
    const contractId = contract.trim().toLowerCase();
    const methodName = method.trim();
    if (!contractId || !methodName) {
      setError("Enter a contract and read-only method.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      setError("Args must be valid JSON.");
      return;
    }

    setBusy(true);
    setError("");
    setResult(null);
    try {
      const value = await new NearRpcClient().viewFunction<unknown>(contractId, methodName, parsed);
      setResult(JSON.stringify(value, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "View call failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid terminal-page">
      <div className="card hero">
        <div>
          <span className="eyebrow">DEVELOPER / READ ONLY</span>
          <h2>Inspect a NEAR contract without signing anything.</h2>
          <p>Calls use final NEAR mainnet RPC state. This tool never sends a transaction.</p>
        </div>
        <div className="hero-state"><span className="status-dot live" /><span>Read-only</span></div>
      </div>

      <div className="card full">
        <div className="two">
          <div><label>Contract ID</label><input value={contract} onChange={(e) => setContract(e.target.value)} placeholder="contract.near" spellCheck={false} /></div>
          <div><label>Method</label><input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="ft_metadata" spellCheck={false} /></div>
        </div>
        <div className="field-spacer">
          <label>Args (JSON)</label>
          <textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={7} spellCheck={false} />
        </div>
        <button onClick={() => void inspect()} disabled={busy}>{busy ? "Reading…" : "Call view method"}</button>
        {error && <p className="message warning">{error}</p>}
      </div>

      {result !== null && (
        <div className="card full">
          <div className="section-head"><div><span className="eyebrow">RESULT</span><h3>Final RPC response</h3></div></div>
          <pre className="code-output">{result}</pre>
        </div>
      )}
    </section>
  );
}

export function PersistedTransactionsView({ campaigns }: { campaigns: Campaign[] }) {
  const rows = campaigns
    .flatMap((campaign) => campaign.batches
      .filter((batch) => batch.transactionHash)
      .map((batch) => ({
        campaignId: campaign.id,
        batchId: batch.id,
        senderId: batch.senderId,
        transactionHash: batch.transactionHash!,
        status: batch.status,
        updatedAt: campaign.updatedAt
      })))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <section className="grid terminal-page">
      <div className="card hero">
        <div>
          <span className="eyebrow">TRANSACTIONS</span>
          <h2>Transactions persisted by the web execution layer.</h2>
          <p>This list is derived only from browser-persisted campaign batches. No demo transaction hashes are shown.</p>
        </div>
        <div className="hero-state"><span className="status-dot live" /><span>{rows.length} recorded</span></div>
      </div>
      <div className="card full">
        {rows.length === 0 ? (
          <div className="empty-state"><h3>No submitted transactions</h3><p className="muted">Execute a campaign and confirmed or submitted transaction hashes will appear here.</p></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Campaign</th><th>Batch</th><th>Sender</th><th>Status</th><th>Transaction</th></tr></thead>
              <tbody>{rows.map((row) => (
                <tr key={row.campaignId + row.batchId}><td>{shortId(row.campaignId)}</td><td>{row.batchId}</td><td>{row.senderId}</td><td className={row.status === "success" ? "ready" : row.status === "failed" ? "warning" : "muted"}>{row.status}</td><td className="mono-value">{row.transactionHash}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

export function TerminalModuleView({
  view,
  onNavigate
}: {
  view: string;
  onNavigate: (view: string) => void;
}) {
  const descriptions: Record<string, {
    eyebrow: string;
    title: string;
    body: string;
    details: Array<[string, string]>;
  }> = {
    "Create token": {
      eyebrow: "LAUNCH / TOKEN",
      title: "Create token is waiting on the verified factory interface.",
      body: "Neyro will not invent a deployment contract, constructor arguments or token address. Once the supported factory is verified, this page can become a real browser-wallet flow.",
      details: [
        ["Contract", "Verified token factory and exact method"],
        ["Review", "Name, symbol, decimals, supply and metadata"],
        ["Signing", "Browser wallet confirmation and transaction reconciliation"]
      ]
    },
    Mint: {
      eyebrow: "TOKEN TOOLS / MINT",
      title: "Mint is ready for the interface, not a guessed transaction.",
      body: "The terminal needs the exact token contract method, owner rules and gas/deposit requirements before it can expose a write.",
      details: [
        ["Method", "Verified mint function and argument schema"],
        ["Authorization", "On-chain owner or minter requirement"],
        ["Safety", "Amount validation and browser-wallet review"]
      ]
    },
    Burn: {
      eyebrow: "TOKEN TOOLS / BURN",
      title: "Burn is waiting on the verified token interface.",
      body: "No burn transaction is exposed until Neyro can prove the method, arguments, caller permissions and deposit/gas requirements.",
      details: [
        ["Method", "Verified burn function and argument schema"],
        ["Amount", "Exact token decimal and balance checks"],
        ["Review", "Explicit irreversible-action confirmation"]
      ]
    },
    Lock: {
      eyebrow: "TOKEN TOOLS / LOCK",
      title: "Lock needs a verified lock contract.",
      body: "A lock is protocol-specific. Neyro will not guess a timelock contract, storage layout or beneficiary arguments.",
      details: [
        ["Contract", "Verified lock/timelock contract"],
        ["Parameters", "Amount, beneficiary and unlock timestamp"],
        ["Safety", "On-chain validation before signing"]
      ]
    },
    Unlock: {
      eyebrow: "TOKEN TOOLS / UNLOCK",
      title: "Unlock needs the verified claim interface.",
      body: "The browser will only expose an unlock transaction after the exact contract and claim rules are verified against live protocol state.",
      details: [
        ["Contract", "Verified lock contract and claim method"],
        ["Eligibility", "Live ownership and unlock-time checks"],
        ["Signing", "Browser wallet with final transaction reconciliation"]
      ]
    },
    "Contract Call": {
      eyebrow: "DEVELOPER / WRITE",
      title: "Generic contract writes remain gated.",
      body: "Read-only inspection is live. Generic writes need an explicit transaction builder with receiver, method, arguments, deposit and gas validation.",
      details: [
        ["Receiver", "Explicit contract account"],
        ["Call", "Method name and validated JSON arguments"],
        ["Review", "Gas, deposit and wallet confirmation"]
      ]
    },
    "Transaction Builder": {
      eyebrow: "DEVELOPER / BUILDER",
      title: "Transaction builder is being wired from real action primitives.",
      body: "The current wallet boundary supports verified function-call and transfer actions. Arbitrary action composition is not exposed yet.",
      details: [
        ["Actions", "Only supported browser-wallet action types"],
        ["Validation", "Receiver, gas and deposit checks"],
        ["Outcome", "Persisted submission and reconciliation"]
      ]
    },
    "Token Operations": {
      eyebrow: "HISTORY / TOKEN OPERATIONS",
      title: "Token-operation history will come from persisted execution state.",
      body: "No synthetic transactions or operation rows are rendered. Once token writes are enabled, their persisted outcomes can appear here.",
      details: [
        ["Source", "Browser-persisted execution records"],
        ["Status", "Submitted, confirmed, failed or unknown"],
        ["Export", "Operation results can be exported after persistence is added"]
      ]
    },
    Swap: {
      eyebrow: "TRADE / SWAP",
      title: "Swap execution is still behind the signing safety gate.",
      body: "Live RHEA quotes are available, but signing remains disabled until wrapping, registration and multi-transaction reconciliation are verified.",
      details: [
        ["Quote", "Live RHEA SmartRouter response"],
        ["Controls", "Slippage, expiry and minimum received"],
        ["Execution", "Browser signing after route lifecycle verification"]
      ]
    }
  };

  const copy = descriptions[view] ?? {
    eyebrow: "TERMINAL",
    title: "Module not available.",
    body: "No route is exposed for this module yet.",
    details: [
      ["State", "No fabricated data"],
      ["Safety", "No unverified transaction"],
      ["Next", "Use an implemented terminal section"]
    ]
  };

  return (
    <section className="module-placeholder card">
      <span className="eyebrow">{copy.eyebrow}</span>
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      <span className="module-status">Integration gated · no transaction exposed</span>
      <div className="module-details">
        {copy.details.map(([title, body]) => (
          <div className="module-detail" key={title}>
            <strong>{title}</strong>
            <span>{body}</span>
          </div>
        ))}
      </div>
      {view === "Create token" && (
        <div className="action-row">
          <button onClick={() => onNavigate("Launch NEARly token")}>Open NEARly launch</button>
        </div>
      )}
    </section>
  );
}

export function NearlyLaunchView({
  accountId,
  wallet
}: {
  accountId: string;
  wallet: WebWalletConnector | null;
}) {
  const emptyForm: LaunchForm = {
    name: "",
    symbol: "",
    description: "",
    icon: "",
    website: "",
    twitter: "",
    telegram: "",
    quote: NEARLY_WNEAR,
    devBuyNear: "0",
    buyBps: 0,
    sellBps: 0,
    creatorBps: 10000,
    burnBps: 0,
    holdersBps: 0
  };
  const [form, setForm] = useState<LaunchForm>(emptyForm);
  const [quotes, setQuotes] = useState<NearlyQuoteAsset[]>([]);
  const [cost, setCost] = useState<LaunchCost | null>(null);
  const [txHash, setTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingPairs, setLoadingPairs] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoadingPairs(true);
    getNearlyLaunchQuotes()
      .then((items) => { if (!cancelled) setQuotes(items); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load NEARly pairs."); })
      .finally(() => { if (!cancelled) setLoadingPairs(false); });
    return () => { cancelled = true; };
  }, []);

  function patch<K extends keyof LaunchForm>(key: K, value: LaunchForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setCost(null);
    setTxHash("");
    setMessage("");
    setError("");
  }

  async function quote() {
    setBusy(true); setError(""); setMessage(""); setTxHash("");
    try {
      const next = await quoteNearlyLaunch(form);
      setCost(next);
      setMessage("Live NEARly launch cost loaded from the factory.");
    } catch (cause) {
      setCost(null);
      setError(cause instanceof Error ? cause.message : "Launch quote failed.");
    } finally {
      setBusy(false);
    }
  }

  async function launch() {
    if (!wallet) { setError("Connect your browser wallet first."); return; }
    setBusy(true); setError(""); setMessage(""); setTxHash("");
    try {
      const result = await launchNearlyToken(form, accountId, wallet);
      setCost(result.cost);
      setTxHash(result.txHash);
      setMessage("Launch transaction submitted. Check the transaction before submitting another launch.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Launch failed.");
    } finally {
      setBusy(false);
    }
  }

  const updateTax = (key: "buyBps" | "sellBps", percent: string) => {
    const parsed = Number(percent);
    patch(key, Number.isFinite(parsed) ? Math.round(parsed * 100) : 0);
  };

  return (
    <section className="grid terminal-page">
      <div className="card hero full">
        <div>
          <span className="eyebrow">LAUNCH / NEARLY</span>
          <h2>Launch a token directly from the browser wallet.</h2>
          <p>Pairs and launch costs are read live from the NEARly factory. The launch transaction is signed by the connected account; Neyro does not custody the wallet.</p>
        </div>
        <div className="hero-state"><span className={accountId ? "status-dot live" : "status-dot"} /><span>{accountId ? shortId(accountId) : "Connect wallet"}</span></div>
      </div>

      <div className="card">
        <div className="section-head"><div><span className="eyebrow">TOKEN</span><h3>Identity</h3></div></div>
        <div className="form-grid">
          <div><label>Name</label><input value={form.name} onChange={(e) => patch("name", e.target.value)} placeholder="Token name" /></div>
          <div><label>Symbol</label><input value={form.symbol} onChange={(e) => patch("symbol", e.target.value.toUpperCase())} placeholder="TICKER" /></div>
          <div className="full-field"><label>Description</label><textarea rows={3} value={form.description} onChange={(e) => patch("description", e.target.value)} placeholder="Optional description" /></div>
          <div className="full-field"><label>Logo URL or uploaded image</label><input value={form.icon} onChange={(e) => patch("icon", e.target.value)} placeholder="https://… or ipfs://…" /></div>
          <div><label>Website</label><input value={form.website} onChange={(e) => patch("website", e.target.value)} placeholder="https://…" /></div>
          <div><label>X</label><input value={form.twitter} onChange={(e) => patch("twitter", e.target.value)} placeholder="https://x.com/…" /></div>
          <div><label>Telegram</label><input value={form.telegram} onChange={(e) => patch("telegram", e.target.value)} placeholder="https://t.me/…" /></div>
        </div>
      </div>

      <div className="card">
        <div className="section-head"><div><span className="eyebrow">PAIR & FIRST BUY</span><h3>Launch settings</h3></div></div>
        <div className="form-grid">
          <div className="full-field">
            <label>Launch pair</label>
            <select value={form.quote} onChange={(e) => patch("quote", e.target.value)}>
              {loadingPairs && <option value={form.quote}>Loading live pairs…</option>}
              {quotes.map((q) => <option key={q.accountId} value={q.accountId}>{q.symbol} · {q.accountId}</option>)}
            </select>
          </div>
          <div>
            <label>First buy (NEAR)</label>
            <input inputMode="decimal" value={form.devBuyNear} onChange={(e) => patch("devBuyNear", e.target.value)} placeholder="0" />
            <small>Native first buy is used by the factory only for the NEAR pair.</small>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="section-head"><div><span className="eyebrow">OPTIONAL TAX</span><h3>Buy / sell tax</h3></div></div>
        <div className="form-grid">
          <div><label>Buy tax (%)</label><input inputMode="decimal" min="0" max="4" step="0.01" value={form.buyBps / 100} onChange={(e) => updateTax("buyBps", e.target.value)} /></div>
          <div><label>Sell tax (%)</label><input inputMode="decimal" min="0" max="4" step="0.01" value={form.sellBps / 100} onChange={(e) => updateTax("sellBps", e.target.value)} /></div>
          {(form.buyBps || form.sellBps) > 0 && (
            <>
              <div><label>Creator share (%)</label><input inputMode="decimal" value={form.creatorBps / 100} onChange={(e) => patch("creatorBps", Math.round(Number(e.target.value || 0) * 100))} /></div>
              <div><label>Burn share (%)</label><input inputMode="decimal" value={form.burnBps / 100} onChange={(e) => patch("burnBps", Math.round(Number(e.target.value || 0) * 100))} /></div>
              <div><label>Holders share (%)</label><input inputMode="decimal" value={form.holdersBps / 100} onChange={(e) => patch("holdersBps", Math.round(Number(e.target.value || 0) * 100))} /></div>
              <div className="tax-total"><span>Distribution</span><strong>{((form.creatorBps + form.burnBps + form.holdersBps) / 100).toFixed(2)}%</strong></div>
            </>
          )}
        </div>
      </div>

      <div className="card full">
        <div className="row-title">
          <div><span className="eyebrow">FACTORY QUOTE</span><h3>{cost ? "Live launch cost" : "Quote before signing"}</h3></div>
          <button onClick={() => void quote()} disabled={busy}>{busy ? "Reading…" : "Get launch cost"}</button>
        </div>
        {cost && (
          <div className="overview-list">
            <div><span>Launch fee</span><strong>{formatNear(cost.launch_fee)}</strong></div>
            <div><span>Token storage</span><strong>{formatNear(cost.token_storage)}</strong></div>
            <div><span>Pool creation</span><strong>{formatNear(cost.pool_create)}</strong></div>
            <div><span>DCL storage</span><strong>{formatNear(cost.dcl_storage)}</strong></div>
            <div><span>First buy</span><strong>{formatNear(cost.dev_buy)}</strong></div>
            <div><span>Total</span><strong>{formatNear(cost.total)}</strong></div>
          </div>
        )}
        <div className="action-row">
          <button className="primary" onClick={() => void launch()} disabled={busy || !accountId}>{busy ? "Working…" : "Launch token"}</button>
        </div>
        {txHash && <p className="message success">Submitted: <span className="mono-value">{txHash}</span></p>}
        {message && <p className="message">{message}</p>}
        {error && <p className="message warning">{error}</p>}
      </div>
    </section>
  );
}

export function SwapView({
  accountId,
  wallet
}: {
  accountId: string;
  wallet: WebWalletConnector | null;
}) {
  const [fromToken, setFromToken] = useState(NEARLY_WNEAR);
  const [toToken, setToToken] = useState("");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("1");
  const [quote, setQuote] = useState<{amountIn:string;amountOut:string;minAmountOut:string;msg:string;signature:string;expiresAt:number;inputDecimals:number;outputDecimals:number}|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [inputDecimals, setInputDecimals] = useState(24);
  const [inputSymbol, setInputSymbol] = useState("wNEAR");
  const [inputBalance, setInputBalance] = useState<bigint | null>(null);
  const [balanceBusy, setBalanceBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const contract = fromToken.trim().toLowerCase();
    if (!accountId || !contract) {
      setInputBalance(null);
      setInputDecimals(24);
      setInputSymbol(contract === "near" ? "NEAR" : "wNEAR");
      setBalanceBusy(false);
      return;
    }
    setBalanceBusy(true);
    const rpc = new NearRpcClient();
    const load = async () => {
      try {
        if (contract === "near") {
          const account = await rpc.viewAccount(accountId);
          if (cancelled) return;
          setInputDecimals(24);
          setInputSymbol("NEAR");
          setInputBalance(BigInt(account.amount));
        } else {
          const [metadata, balance] = await Promise.all([
            rpc.viewFunction<{decimals:number; symbol:string}>(contract, "ft_metadata", {}),
            rpc.viewFunction<string>(contract, "ft_balance_of", { account_id: accountId })
          ]);
          if (!/^\d+$/.test(balance)) throw new Error("Token returned an invalid balance.");
          if (cancelled) return;
          setInputDecimals(metadata.decimals);
          setInputSymbol(metadata.symbol);
          setInputBalance(BigInt(balance));
        }
      } catch {
        if (!cancelled) {
          setInputBalance(null);
          setInputDecimals(24);
          setInputSymbol(contract === "near" ? "NEAR" : "Token");
        }
      } finally {
        if (!cancelled) setBalanceBusy(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [accountId, fromToken]);

  useEffect(() => {
    if (!quote) {
      setSecondsLeft(0);
      return;
    }
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((quote.expiresAt - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [quote]);

  function switchTokens() {
    setFromToken(toToken || NEARLY_WNEAR);
    setToToken(fromToken === NEARLY_WNEAR ? "" : fromToken);
    setQuote(null);
    setNotice("");
    setError("");
  }

  async function getQuote() {
    if (!accountId) throw new Error("Connect your wallet to get a live route.");
    const value = amount.trim();
    if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) <= 0) throw new Error("Enter a valid amount.");
    const target = toToken.trim().toLowerCase();
    if (!target) throw new Error("Enter the output token contract.");
    if (target === fromToken.trim().toLowerCase()) throw new Error("Choose two different tokens.");

    const rpc = new NearRpcClient();
    const inputContract = fromToken.trim().toLowerCase();
    const resolvedInputDecimals = inputContract === "near"
      ? 24
      : (await rpc.viewFunction<{decimals:number}>(inputContract, "ft_metadata", {})).decimals;
    const outputDecimals = (await rpc.viewFunction<{decimals:number}>(target, "ft_metadata", {}).catch(() => ({decimals: 24}))).decimals;
    const base = toBase(value, resolvedInputDecimals);
    const bps = Math.round(Number(slippage) * 100);
    if (!Number.isInteger(bps) || bps < 0 || bps > 1000) throw new Error("Slippage must be between 0% and 10%.");

    const url = new URL("https://smartx.rhea.finance/swapMultiDexPath");
    url.searchParams.set("amountIn", base.toString());
    url.searchParams.set("tokenIn", fromToken === "near" ? NEARLY_WNEAR : fromToken);
    url.searchParams.set("tokenOut", target);
    url.searchParams.set("slippage", String(bps / 10000));
    url.searchParams.set("user", accountId);
    url.searchParams.set("receiveUser", accountId);
    url.searchParams.set("skipUnwrapNativeToken", "false");

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new Error("RHEA quote HTTP " + response.status);

    const data = (body?.result_data && typeof body.result_data === "object" ? body.result_data : body) as Record<string, unknown>;
    const amountIn = String(data?.amount_in ?? data?.amountIn ?? "");
    const amountOut = String(data?.amount_out ?? data?.amountOut ?? "");
    const minAmountOut = String(data?.min_amount_out ?? data?.minAmountOut ?? "");
    const msg = String(data?.msg ?? "");
    const signature = String(data?.signature ?? "");

    if (!/^\d+$/.test(amountIn) || BigInt(amountIn) !== base) throw new Error("RHEA returned an invalid input amount.");
    if (!/^\d+$/.test(amountOut) || BigInt(amountOut) <= 0n) throw new Error("RHEA returned no executable output.");
    const minimum = /^\d+$/.test(minAmountOut)
      ? minAmountOut
      : (BigInt(amountOut) * BigInt(10000 - bps) / 10000n).toString();

    if (BigInt(minimum) <= 0n || BigInt(minimum) > BigInt(amountOut) || !msg || !signature) {
      throw new Error("RHEA returned an incomplete executable route.");
    }

    setQuote({ amountIn, amountOut, minAmountOut: minimum, msg, signature, expiresAt: Date.now() + 45000, inputDecimals: resolvedInputDecimals, outputDecimals });
  }

  async function runQuote() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await getQuote();
      setNotice("Live RHEA route loaded. Review the route before signing.");
    } catch (cause) {
      setQuote(null);
      setError(cause instanceof Error ? cause.message : "Quote failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="swap-page">
      <div className="swap-shell">
        <div className="swap-heading">
          <div>
            <span className="eyebrow">TRADE / RHEA</span>
            <h2>Swap tokens</h2>
            <p>Live routing through RHEA SmartRouter. Quotes are fetched when you request them.</p>
          </div>
          <div className="swap-wallet-status">
            <span className={accountId ? "status-dot live" : "status-dot"} />
            <span>{accountId ? shortId(accountId) : "Wallet not connected"}</span>
          </div>
        </div>

        <div className="swap-card">
          <div className="swap-card-top">
            <span>Swap</span>
            <button className={`icon-button${settingsOpen ? " active" : ""}`} type="button" aria-label="Swap settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>⚙</button>
          </div>

          <div className="swap-token-box">
            <div className="swap-token-label">
              <span>From</span>
              <span>{inputSymbol} · {balanceBusy ? "Reading balance…" : inputBalance !== null ? formatBaseValue(inputBalance.toString(), inputDecimals) : "Balance unavailable"}</span>
            </div>
            <div className="swap-token-row">
              <input
                className="swap-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setQuote(null); setNotice(""); }}
                placeholder="0.00"
              />
              <input
                className="swap-contract"
                value={fromToken}
                onChange={(e) => { setFromToken(e.target.value.trim().toLowerCase()); setQuote(null); }}
                placeholder="wrap.near"
                spellCheck={false}
                aria-label="Input token contract"
              />
            </div>
            <div className="swap-token-hint"><span>Contract · {fromToken || "not set"}</span>{inputBalance !== null && <button type="button" className="swap-max" onClick={() => { setAmount(formatBaseValue(inputBalance.toString(), inputDecimals)); setQuote(null); }}>MAX</button>}</div>
          </div>

          <button className="swap-switch" type="button" onClick={switchTokens} aria-label="Switch tokens">↓</button>

          <div className="swap-token-box">
            <div className="swap-token-label">
              <span>To</span>
              <span>NEP-141</span>
            </div>
            <div className="swap-token-row">
              <div className="swap-output">{quote ? formatBaseValue(quote.amountOut, quote.outputDecimals) : "0.00"}</div>
              <input
                className="swap-contract"
                value={toToken}
                onChange={(e) => { setToToken(e.target.value.trim().toLowerCase()); setQuote(null); }}
                placeholder="token.near"
                spellCheck={false}
                aria-label="Output token contract"
              />
            </div>
            <div className="swap-token-hint">{quote ? (secondsLeft > 0 ? `Quoted output · expires in ${secondsLeft}s` : "Quote expired · refresh before signing") : "Enter the token contract to receive"}</div>
          </div>

          {settingsOpen && (
            <div className="swap-settings-popover">
              <div>
                <span className="eyebrow">SWAP SETTINGS</span>
                <strong>Slippage tolerance</strong>
              </div>
              <div className="swap-custom-slippage">
                <input
                  inputMode="decimal"
                  value={slippage}
                  onChange={(e) => { setSlippage(e.target.value); setQuote(null); }}
                  aria-label="Custom slippage percentage"
                />
                <span>%</span>
              </div>
              <small>Maximum allowed: 10%. A quote is invalidated whenever slippage changes.</small>
            </div>
          )}

          <div className="swap-settings-row">
            <div>
              <span>Slippage tolerance</span>
              <strong>{slippage}%</strong>
            </div>
            <div className="swap-slippage">
              {["0.5", "1", "2"].map((value) => (
                <button
                  key={value}
                  type="button"
                  className={slippage === value ? "selected" : ""}
                  onClick={() => { setSlippage(value); setQuote(null); }}
                >
                  {value}%
                </button>
              ))}
            </div>
          </div>

          <button className="swap-primary" type="button" onClick={() => void runQuote()} disabled={busy || !wallet}>
            {busy ? "Finding best route…" : quote ? "Refresh quote" : accountId ? "Get quote" : "Connect wallet to swap"}
          </button>

          {error && <p className="message warning">{error}</p>}
          {notice && <p className="message">{notice}</p>}
        </div>

        {quote && (
          <div className="swap-route-card">
            <div className="swap-route-head">
              <div>
                <span className="eyebrow">ROUTE</span>
                <h3>RHEA SmartRouter</h3>
              </div>
              <span className="route-live">LIVE</span>
            </div>
            <div className="swap-route-grid">
              <div><span>You'll pay</span><strong>{formatBaseValue(quote.amountIn, quote.inputDecimals)}</strong></div>
              <div><span>You'll receive</span><strong>{formatBaseValue(quote.amountOut, quote.outputDecimals)}</strong></div>
              <div><span>Minimum received</span><strong>{formatBaseValue(quote.minAmountOut, quote.outputDecimals)}</strong></div>
              <div><span>Quote expiry</span><strong>{secondsLeft > 0 ? `${secondsLeft}s` : "Expired"}</strong></div>
            </div>
            <button className="swap-review" type="button" disabled>
              Review & sign — execution coming next
            </button>
            <p className="message">The route is live and validated. Signing remains disabled until wrapping, token registration and multi-transaction reconciliation are fully persisted.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function formatBaseValue(value: string, decimals: number): string {
  try {
    const base = BigInt(value);
    const divisor = 10n ** BigInt(decimals);
    const whole = base / divisor;
    const fraction = (base % divisor).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
    return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
  } catch {
    return value;
  }
}

function toBase(value:string, decimals:number):bigint {
  if(!/^\d+(?:\.\d+)?$/.test(value) || decimals<0 || decimals>24) throw new Error("Invalid amount");
  const [whole,fraction=""]=value.split(".");
  if(fraction.length>decimals) throw new Error("Too many decimals");
  const base=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,"0")||"0");
  if(base<=0n) throw new Error("Amount must be greater than zero");
  return base;
}
