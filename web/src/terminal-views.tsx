import { useEffect, useState } from "react";
import type { Campaign } from "./campaign/model";
import { NearRpcClient } from "./near/rpc";

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
  );
}
