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
  const descriptions: Record<string, { eyebrow: string; title: string; body: string }> = {
    Swap: {
      eyebrow: "TRADE / SWAP",
      title: "Swap is not faking a quote.",
      body: "The web terminal will only show a route after a verified web-compatible router and signing path are connected."
    },
    Orders: {
      eyebrow: "TRADE / ORDERS",
      title: "No synthetic orders.",
      body: "Orders will be populated from the real trading execution repository once its web persistence and signing boundary are wired."
    },
    "Launch NEARly token": {
      eyebrow: "LAUNCH / NEARLY",
      title: "Launch flow is the next protocol adapter.",
      body: "The terminal shell is ready, but the web launch transaction path is not enabled yet. No fabricated launch cost, pool, or token address is shown."
    },
    "Create token": {
      eyebrow: "LAUNCH / TOKEN",
      title: "Token creation is gated until the contract interface is verified.",
      body: "This page intentionally contains no fake contract address or deployment result."
    },
    Mint: {
      eyebrow: "TOKEN TOOLS / MINT",
      title: "Mint requires a verified token contract interface.",
      body: "The browser will not guess an owner/mint method or send a write transaction without an exact interface."
    },
    Burn: {
      eyebrow: "TOKEN TOOLS / BURN",
      title: "Burn requires a verified token contract interface.",
      body: "No write is exposed until the exact burn method, arguments, gas and deposit requirements are verified."
    },
    Lock: {
      eyebrow: "TOKEN TOOLS / LOCK",
      title: "Lock requires a verified contract interface.",
      body: "No lock transaction is exposed until the exact contract method and safety checks are verified."
    },
    Unlock: {
      eyebrow: "TOKEN TOOLS / UNLOCK",
      title: "Unlock requires a verified contract interface.",
      body: "No unlock transaction is exposed until the exact contract method and safety checks are verified."
    },
    "Contract Call": {
      eyebrow: "DEVELOPER / WRITE",
      title: "Generic contract writes remain gated.",
      body: "Read-only inspection is live. Generic writes need an explicit transaction builder with receiver, method, args, deposit and gas validation."
    },
    "Transaction Builder": {
      eyebrow: "DEVELOPER / BUILDER",
      title: "Transaction builder is being wired from real action primitives.",
      body: "The current web wallet boundary supports verified function-call and transfer actions; arbitrary action composition is not exposed yet."
    },
    "Token Operations": {
      eyebrow: "HISTORY / TOKEN OPERATIONS",
      title: "No token-operation history is fabricated.",
      body: "This view will use persisted token-operation records once the corresponding web execution flows are enabled."
    }
  };

  const copy = descriptions[view] ?? {
    eyebrow: "TERMINAL",
    title: "Module not available.",
    body: "No route is exposed for this module yet."
  };

  return (
    <section className="module-placeholder card">
      <span className="eyebrow">{copy.eyebrow}</span>
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
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
  const [fromToken, setFromToken] = useState("wrap.near");
  const [toToken, setToToken] = useState("");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("1");
  const [quote, setQuote] = useState<{amountIn:string;amountOut:string;minAmountOut:string;msg:string;signature:string;expiresAt:number}|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function getQuote() {
    if (!accountId) throw new Error("Connect wallet first");
    const value=amount.trim();
    if(!/^\d+(?:\.\d+)?$/.test(value) || Number(value)<=0) throw new Error("Enter a valid amount");
    const target=toToken.trim().toLowerCase();
    if(!target) throw new Error("Enter the output token contract");
    const decimals=await new NearRpcClient().viewFunction<{decimals:number}>(target,"ft_metadata",{}).catch(()=>({decimals:24}));
    const base=toBase(value,decimals.decimals);
    const bps=Math.round(Number(slippage)*100);
    if(!Number.isInteger(bps)||bps<0||bps>1000) throw new Error("Slippage must be between 0% and 10%");
    const url=new URL("https://smartx.rhea.finance/swapMultiDexPath");
    url.searchParams.set("amountIn",base.toString());
    url.searchParams.set("tokenIn",fromToken==="near"?"wrap.near":fromToken);
    url.searchParams.set("tokenOut",target);
    url.searchParams.set("slippage",String(bps/10000));
    url.searchParams.set("user",accountId);
    url.searchParams.set("receiveUser",accountId);
    url.searchParams.set("skipUnwrapNativeToken","false");
    const response=await fetch(url,{headers:{Accept:"application/json"}});
    const body=await response.json().catch(()=>null) as Record<string,unknown>|null;
    if(!response.ok) throw new Error("RHEA quote HTTP "+response.status);
    const data=(body?.result_data && typeof body.result_data==="object"?body.result_data:body) as Record<string,unknown>;
    const amountIn=String(data?.amount_in??data?.amountIn??"");
    const amountOut=String(data?.amount_out??data?.amountOut??"");
    const minAmountOut=String(data?.min_amount_out??data?.minAmountOut??"");
    const msg=String(data?.msg??"");
    const signature=String(data?.signature??"");
    if(!/^\d+$/.test(amountIn)||BigInt(amountIn)!==base) throw new Error("RHEA returned an invalid input amount");
    if(!/^\d+$/.test(amountOut)||BigInt(amountOut)<=0n) throw new Error("RHEA returned no executable output");
    const minimum=/^\d+$/.test(minAmountOut)?minAmountOut:((BigInt(amountOut)*BigInt(10000-bps))/10000n).toString();
    if(BigInt(minimum)<=0n||BigInt(minimum)>BigInt(amountOut)||!msg||!signature) throw new Error("RHEA returned an incomplete executable route");
    setQuote({amountIn,amountOut,minAmountOut:minimum,msg,signature,expiresAt:Date.now()+45000});
  }

  async function runQuote() {
    setBusy(true); setError(""); setNotice("");
    try { await getQuote(); setNotice("Live RHEA route loaded. No fabricated quote data."); }
    catch(cause){setQuote(null);setError(cause instanceof Error?cause.message:"Quote failed.");}
    finally{setBusy(false);}
  }

  return (
    <section className="grid terminal-page">
      <div className="card hero full">
        <div>
          <span className="eyebrow">TRADE / RHEA</span>
          <h2>Live swap routing from RHEA SmartRouter.</h2>
          <p>Enter a NEAR or NEP-141 token contract. Quotes are fetched at request time and expire quickly.</p>
        </div>
        <div className="hero-state"><span className={accountId ? "status-dot live" : "status-dot"} /><span>{accountId ? shortId(accountId) : "Connect wallet"}</span></div>
      </div>
      <div className="card">
        <div className="form-grid">
          <div><label>Input token</label><input value={fromToken} onChange={(e)=>setFromToken(e.target.value.trim().toLowerCase())} placeholder="wrap.near" /></div>
          <div><label>Output token contract</label><input value={toToken} onChange={(e)=>setToToken(e.target.value.trim().toLowerCase())} placeholder="token.near" /></div>
          <div><label>Amount</label><input inputMode="decimal" value={amount} onChange={(e)=>setAmount(e.target.value)} placeholder="0.0" /></div>
          <div><label>Slippage (%)</label><input inputMode="decimal" value={slippage} onChange={(e)=>setSlippage(e.target.value)} /></div>
        </div>
        <div className="action-row"><button className="primary" onClick={()=>void runQuote()} disabled={busy}>{busy?"Routing…":"Get quote"}</button></div>
        {error && <p className="message warning">{error}</p>}
        {notice && <p className="message">{notice}</p>}
      </div>
      {quote && (
        <div className="card full">
          <div className="row-title"><div><span className="eyebrow">ROUTE</span><h3>Executable quote</h3></div><span className="muted">{Math.max(0,Math.round((quote.expiresAt-Date.now())/1000))}s</span></div>
          <div className="overview-list">
            <div><span>Input</span><strong className="mono-value">{quote.amountIn}</strong></div>
            <div><span>Expected output</span><strong className="mono-value">{quote.amountOut}</strong></div>
            <div><span>Minimum output</span><strong className="mono-value">{quote.minAmountOut}</strong></div>
            <div><span>Router</span><strong>RHEA SmartRouter</strong></div>
          </div>
          <p className="muted">Execution is intentionally not enabled yet for this quote path. The next execution step must persist the route and handle NEAR wrapping/registration safely.</p>
        </div>
      )}
    </section>
  );
}

function toBase(value:string, decimals:number):bigint {
  if(!/^\d+(?:\.\d+)?$/.test(value) || decimals<0 || decimals>24) throw new Error("Invalid amount");
  const [whole,fraction=""]=value.split(".");
  if(fraction.length>decimals) throw new Error("Too many decimals");
  const base=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,"0")||"0");
  if(base<=0n) throw new Error("Amount must be greater than zero");
  return base;
}
