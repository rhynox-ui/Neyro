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

export function TokenBurnView({
  accountId,
  wallet
}: {
  accountId: string;
  wallet: WebWalletConnector | null;
}) {
  const [token, setToken] = useState("");
  const [metadata, setMetadata] = useState<{ name?: string; symbol: string; decimals: number } | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [txHash, setTxHash] = useState("");

  async function loadToken() {
    const contract = token.trim().toLowerCase();
    if (!contract) {
      setError("Enter a token contract.");
      return;
    }
    if (!accountId) {
      setError("Connect a browser wallet first.");
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");
    setMetadata(null);
    setBalance(null);
    try {
      const rpc = new NearRpcClient();
      const launch = await rpc.viewFunction<Record<string, unknown> | null>(
        "nearlytrade.near",
        "get_launch_by_token",
        { token: contract }
      );
      if (!launch || launch.token !== contract || launch.step !== "Done") {
        throw new Error("Burn is currently enabled only for completed NEARly launches.");
      }

      const meta = await rpc.viewFunction<{ spec?: string; name?: string; symbol?: string; decimals?: number }>(
        contract,
        "ft_metadata",
        {}
      );
      if (meta.spec !== "ft-1.0.0" && meta.spec !== "ft-1.0.0".toLowerCase() && !String(meta.spec ?? "").startsWith("ft-")) {
        throw new Error("Contract is not exposing a NEP-141 token interface.");
      }
      const symbol = meta.symbol;
      const decimals = meta.decimals;
      if (typeof symbol !== "string" || typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 64) {
        throw new Error("Token metadata is invalid.");
      }

      const rawBalance = await rpc.viewFunction<string>(contract, "ft_balance_of", { account_id: accountId });
      if (!/^\d+$/.test(rawBalance)) throw new Error("Token returned an invalid balance.");

      setMetadata({
        symbol,
        decimals,
        ...(typeof meta.name === "string" ? { name: meta.name } : {})
      });
      setBalance(BigInt(rawBalance));
      setMessage("NEARly launch verified. Burn removes tokens from your own balance permanently.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to verify token.");
    } finally {
      setLoading(false);
    }
  }

  async function burn() {
    const contract = token.trim().toLowerCase();
    if (!wallet || !accountId || !metadata || balance === null) {
      setError("Load a verified NEARly token and connect the browser wallet.");
      return;
    }

    let base: bigint;
    try {
      base = toTokenBase(amount, metadata.decimals);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid burn amount.");
      return;
    }
    if (base > balance) {
      setError("Burn amount exceeds your current token balance.");
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");
    setTxHash("");
    try {
      const result = await wallet.signAndSend({
        signerId: accountId,
        receiverId: contract,
        actions: [{
          type: "FunctionCall",
          receiverId: contract,
          methodName: "burn",
          args: { amount: base.toString() },
          gas: 30_000_000_000_000n,
          deposit: 0n
        }]
      });
      if (!result.transactionHash) throw new Error("Wallet did not return a transaction hash.");
      setTxHash(result.transactionHash);
      setMessage("Burn transaction submitted. Verify the final transaction before treating the balance as reduced.");
      setAmount("");
      await loadToken();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Burn transaction failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid terminal-page">
      <div className="card hero">
        <div>
          <span className="eyebrow">TOKEN TOOLS / BURN</span>
          <h2>Burn tokens from your own NEARly balance.</h2>
          <p>NEARly launch tokens have fixed supply. A holder can permanently burn tokens they own; Neyro never submits a burn for another account.</p>
        </div>
        <div className="hero-state"><span className={accountId ? "status-dot live" : "status-dot"} /><span>{accountId ? "Wallet connected" : "Connect wallet"}</span></div>
      </div>

      <div className="card full">
        <div className="section-head">
          <div><span className="eyebrow">NEARLY TOKEN</span><h3>Verify token</h3></div>
          <button onClick={() => void loadToken()} disabled={loading}>{loading ? "Reading…" : "Verify token"}</button>
        </div>
        <label>Token contract</label>
        <input value={token} onChange={(e) => { setToken(e.target.value.trim().toLowerCase()); setMetadata(null); setBalance(null); setError(""); setMessage(""); }} placeholder="ticker.nearlytrade.near" spellCheck={false} />
        {metadata && (
          <div className="token-tool-summary">
            <div><span>Token</span><strong>{metadata.name ?? metadata.symbol} · {metadata.symbol}</strong></div>
            <div><span>Balance</span><strong>{formatTokenBase(balance ?? 0n, metadata.decimals)} {metadata.symbol}</strong></div>
            <div><span>Decimals</span><strong>{metadata.decimals}</strong></div>
          </div>
        )}
      </div>

      {metadata && balance !== null && (
        <div className="card full burn-card">
          <div className="section-head"><div><span className="eyebrow">IRREVERSIBLE ACTION</span><h3>Burn your tokens</h3></div></div>
          <div className="two">
            <div>
              <label>Amount</label>
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="tool-balance">
              <span>Available</span>
              <strong>{formatTokenBase(balance, metadata.decimals)} {metadata.symbol}</strong>
              <button type="button" onClick={() => setAmount(formatTokenBase(balance, metadata.decimals))}>Use full balance</button>
            </div>
          </div>
          <div className="burn-warning">Burning permanently reduces total supply. The transaction cannot be reversed.</div>
          <button className="primary" onClick={() => void burn()} disabled={busy || !wallet || !accountId}>
            {busy ? "Submitting burn…" : "Burn tokens"}
          </button>
          {txHash && <p className="message success">Submitted: <span className="mono-value">{txHash}</span></p>}
          {message && <p className="message">{message}</p>}
          {error && <p className="message warning">{error}</p>}
        </div>
      )}
    </section>
  );
}

function toTokenBase(value: string, decimals: number): bigint {
  const clean = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(clean)) throw new Error("Enter a valid token amount.");
  const [whole, fraction = ""] = clean.split(".");
  if (fraction.length > decimals) throw new Error(`Amount supports at most ${decimals} decimals.`);
  const base = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (base <= 0n) throw new Error("Amount must be greater than zero.");
  return base;
}


export function TokenMintView({
  accountId,
  wallet
}: {
  accountId: string;
  wallet: WebWalletConnector | null;
}) {
  type MintProfile = "mint_receiver_id" | "mint_account_id" | "custom";
  type TokenState = { name: string; symbol: string; decimals: number; spec: string; totalSupply: bigint; balance: bigint; icon?: string | null };

  const [token, setToken] = useState("");
  const [recipient, setRecipient] = useState(accountId);
  const [amount, setAmount] = useState("");
  const [profile, setProfile] = useState<MintProfile>("mint_receiver_id");
  const [customMethod, setCustomMethod] = useState("mint");
  const [customArgs, setCustomArgs] = useState("{}");
  const [gasTgas, setGasTgas] = useState("100");
  const [depositNear, setDepositNear] = useState("0");
  const [state, setState] = useState<TokenState | null>(null);
  const [recipientStorage, setRecipientStorage] = useState<"registered" | "not-registered" | "unsupported" | "unknown">("unknown");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [txHash, setTxHash] = useState("");
  const [submittedAmount, setSubmittedAmount] = useState("");

  useEffect(() => { if (!recipient && accountId) setRecipient(accountId); }, [accountId, recipient]);

  function clearFeedback() { setError(""); setMessage(""); setTxHash(""); }

  async function verifyToken() {
    const contract = token.trim().toLowerCase();
    if (!contract) { setError("Enter the token contract."); return; }
    setLoading(true); setError(""); setMessage(""); setTxHash(""); setState(null); setRecipientStorage("unknown");
    try {
      const rpc = new NearRpcClient();
      const [metadata, totalSupply, balance] = await Promise.all([
        rpc.viewFunction<{spec:string;name:string;symbol:string;decimals:number;icon?:string|null}>(contract, "ft_metadata", {}),
        rpc.viewFunction<string>(contract, "ft_total_supply", {}),
        accountId ? rpc.viewFunction<string>(contract, "ft_balance_of", { account_id: accountId }) : Promise.resolve("0")
      ]);
      if (metadata.spec !== "ft-1.0.0") throw new Error("Contract does not report the NEP-141 metadata spec ft-1.0.0.");
      if (!metadata.name || !metadata.symbol || !Number.isInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 24) throw new Error("Token metadata is incomplete or invalid.");
      if (!/^\d+$/.test(totalSupply) || !/^\d+$/.test(balance)) throw new Error("Token returned an invalid supply or balance.");
      let storage: typeof recipientStorage = "unsupported";
      if (recipient.trim()) {
        try {
          const result = await rpc.viewFunction<{total?:string}|null>(contract, "storage_balance_of", { account_id: recipient.trim().toLowerCase() });
          storage = result && typeof result === "object" ? "registered" : "not-registered";
        } catch { storage = "unsupported"; }
      }
      setState({ name: metadata.name, symbol: metadata.symbol, decimals: metadata.decimals, spec: metadata.spec, totalSupply: BigInt(totalSupply), balance: BigInt(balance), icon: metadata.icon });
      setRecipientStorage(storage);
      setMessage("Token loaded from live NEAR mainnet state. Mint authority is checked by the token contract when the transaction executes.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Token verification failed.");
    } finally { setLoading(false); }
  }

  function buildMintArgs(): Record<string, unknown> {
    const receiver = recipient.trim().toLowerCase();
    const base = toTokenBase(amount, state?.decimals ?? 0);
    if (profile === "mint_receiver_id") return { receiver_id: receiver, amount: base.toString() };
    if (profile === "mint_account_id") return { account_id: receiver, amount: base.toString() };
    let parsed: unknown;
    try { parsed = JSON.parse(customArgs); } catch { throw new Error("Custom mint args must be valid JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Custom mint args must be a JSON object.");
    return parsed as Record<string, unknown>;
  }

  function mintMethod(): string {
    if (profile === "mint_receiver_id" || profile === "mint_account_id") return "mint";
    const method = customMethod.trim();
    if (!method) throw new Error("Enter the custom mint method.");
    if (!/^[a-zA-Z0-9_$:-]{1,128}$/.test(method)) throw new Error("Mint method contains invalid characters.");
    return method;
  }

  function gas(): bigint {
    const value = Number(gasTgas);
    if (!Number.isFinite(value) || value < 1 || value > 300) throw new Error("Gas must be between 1 and 300 Tgas.");
    return BigInt(Math.round(value * 1_000_000_000_000));
  }

  function deposit(): bigint { return toNearYocto(depositNear); }

  function afterSupply(): string {
    if (!state || !amount.trim()) return "—";
    try { return formatTokenBase(state.totalSupply + toTokenBase(amount, state.decimals), state.decimals); }
    catch { return "Invalid amount"; }
  }

  async function mint() {
    if (!wallet || !accountId) { setError("Connect the browser wallet first."); return; }
    if (!state) { setError("Load the token before minting."); return; }
    const contract = token.trim().toLowerCase();
    const receiver = recipient.trim().toLowerCase();
    if (!/^(?=.{2,64}$)(?:[a-z\d]+(?:[-_][a-z\d]+)*\.)*[a-z\d]+(?:[-_][a-z\d]+)*$/.test(receiver)) { setError("Enter a valid NEAR recipient account."); return; }
    let args: Record<string, unknown>; let method: string; let callGas: bigint; let attached: bigint;
    try { args = buildMintArgs(); method = mintMethod(); callGas = gas(); attached = deposit(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Mint parameters are invalid."); return; }
    setBusy(true); setError(""); setMessage(""); setTxHash("");
    try {
      const result = await wallet.signAndSend({ signerId: accountId, receiverId: contract, actions: [{ type:"FunctionCall", receiverId:contract, methodName:method, args, gas:callGas, deposit:attached }] });
      if (!result.transactionHash) throw new Error("Wallet did not return a transaction hash. If the wallet redirected for signing, verify the transaction before retrying.");
      const submittedHash = result.transactionHash;
      setTxHash(submittedHash);
      setSubmittedAmount(previewAmount === "Invalid amount" ? amount.trim() : previewAmount);
      setMessage("Mint transaction submitted. Wait for finality, then reload the token state to confirm the new supply.");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Mint transaction failed."); }
    finally { setBusy(false); }
  }

  const previewAmount = state && amount.trim() ? (() => { try { return formatTokenBase(toTokenBase(amount, state.decimals), state.decimals); } catch { return "Invalid amount"; } })() : "—";

  return (
    <section className="grid terminal-page mint-page">
      <div className="card hero full">
        <div><span className="eyebrow">TOKEN TOOLS / MINT</span><h2>Mint additional token supply.</h2><p>Use this for a token you already control. Load the NEP-141 contract, choose the recipient and amount, then sign the token's mint method from your browser wallet.</p></div>
        <div className="hero-state"><span className={accountId ? "status-dot live" : "status-dot"} /><span>{accountId ? "Wallet connected" : "Connect wallet"}</span></div>
      </div>

      <div className="card full mint-token-card">
        <div className="section-head"><div><span className="eyebrow">01 / TOKEN</span><h3>Choose token</h3></div><button onClick={() => void verifyToken()} disabled={loading || !token.trim()}>{loading ? "Loading…" : "Load token"}</button></div>
        <div className="mint-contract-row">
          <div><label>Token contract</label><input value={token} onChange={(event) => { setToken(event.target.value.trim().toLowerCase()); setState(null); clearFeedback(); }} placeholder="your-token.near" spellCheck={false} /><small>Paste the NEP-141 contract that contains the mint authority you control.</small></div>
          {state && <div className="mint-token-identity">{state.icon?.startsWith("data:image/") || state.icon?.startsWith("https://") ? <img src={state.icon} alt="" className="mint-token-icon" /> : <span className="mint-token-icon mint-token-icon-fallback">{state.symbol.slice(0,2)}</span>}<div><strong>{state.name}</strong><span>{state.symbol} · {state.spec}</span></div></div>}
        </div>
        {state && <div className="mint-stats"><div><span>Current supply</span><strong>{formatTokenBase(state.totalSupply,state.decimals)} {state.symbol}</strong></div><div><span>Your balance</span><strong>{formatTokenBase(state.balance,state.decimals)} {state.symbol}</strong></div><div><span>Decimals</span><strong>{state.decimals}</strong></div><div><span>Standard</span><strong className="ready">NEP-141</strong></div></div>}
        {state && txHash && <div className="mint-confirmation"><div><span>Submitted mint</span><strong>{submittedAmount || "—"} {state.symbol}</strong></div><button type="button" onClick={() => void verifyToken()} disabled={loading}>Reload token state</button></div>}
      </div>

      {state ? <>
        <div className="card mint-form-card">
          <div className="section-head"><div><span className="eyebrow">02 / MINT</span><h3>Issue supply</h3></div><span className="mint-live">TOKEN CONTRACT</span></div>
          <div className="mint-field"><label>Mint to</label><div className="mint-recipient-row"><input value={recipient} onChange={(event) => { setRecipient(event.target.value.trim().toLowerCase()); setRecipientStorage("unknown"); clearFeedback(); }} placeholder={accountId || "recipient.near"} spellCheck={false} />{accountId && <button type="button" onClick={() => { setRecipient(accountId); setRecipientStorage("unknown"); }}>My wallet</button>}</div><small>{recipientStorage === "registered" ? "Recipient storage is registered." : recipientStorage === "not-registered" ? "Recipient is not registered under NEP-145; the token's mint method must handle registration or the call may fail." : recipientStorage === "unsupported" ? "Token does not expose the standard storage_balance_of view." : "Load the token again after changing the recipient to inspect storage state."}</small></div>
          <div className="mint-field"><label>Amount <span className="optional">in {state.symbol}</span></label><div className="mint-amount-row"><input inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); clearFeedback(); }} placeholder="1,000" /><span>{state.symbol}</span></div></div>
          <div className="mint-supply-preview"><div><span>Current supply</span><strong>{formatTokenBase(state.totalSupply,state.decimals)} {state.symbol}</strong></div><div className="mint-supply-arrow">→</div><div><span>After mint</span><strong>{afterSupply()} {state.symbol}</strong></div></div>
          <div className="mint-field"><label>Mint method</label><select value={profile} onChange={(event) => { setProfile(event.target.value as MintProfile); clearFeedback(); }}><option value="mint_receiver_id">mint(receiver_id, amount)</option><option value="mint_account_id">mint(account_id, amount)</option><option value="custom">Custom contract method</option></select><small>NEP-141 does not define a universal mint method. Use the preset only when your token implements that exact interface.</small></div>
          {profile === "custom" && <div className="mint-custom-grid"><div className="mint-field"><label>Method</label><input value={customMethod} onChange={(event) => setCustomMethod(event.target.value)} placeholder="mint" spellCheck={false} /></div><div className="mint-field full-field"><label>Arguments JSON</label><textarea value={customArgs} onChange={(event) => setCustomArgs(event.target.value)} rows={5} spellCheck={false} placeholder='{"receiver_id":"alice.near","amount":"1000000"}' /></div></div>}
          <details className="mint-advanced"><summary>Advanced transaction settings</summary><div className="two"><div className="mint-field"><label>Gas (Tgas)</label><input inputMode="decimal" value={gasTgas} onChange={(event) => setGasTgas(event.target.value)} /></div><div className="mint-field"><label>Attached deposit (NEAR)</label><input inputMode="decimal" value={depositNear} onChange={(event) => setDepositNear(event.target.value)} /></div></div></details>
        </div>

        <div className="card mint-review-card">
          <div className="section-head"><div><span className="eyebrow">03 / REVIEW</span><h3>Mint transaction</h3></div><span className="mint-interface-status warning">VERIFY METHOD</span></div>
          <div className="mint-review-list"><div><span>Token</span><strong>{state.name} ({state.symbol})</strong></div><div><span>Contract</span><strong>{shortId(token.trim().toLowerCase())}</strong></div><div><span>Method</span><strong>{mintMethodLabel(profile,customMethod)}</strong></div><div><span>Mint to</span><strong>{shortId(recipient.trim().toLowerCase() || "—")}</strong></div><div><span>Amount</span><strong>{previewAmount} {state.symbol}</strong></div><div><span>Attached deposit</span><strong>{depositNear || "0"} NEAR</strong></div><div><span>Network</span><strong>NEAR mainnet</strong></div></div>
          <div className="mint-note"><strong>Minting is contract-controlled.</strong> NEP-141 defines the fungible-token interface, not who may mint or what the mint method is called. Neyro never assumes that a token is mintable just because it is NEP-141. The transaction is sent to the exact method and arguments you selected.</div>
          <button className="primary mint-submit" onClick={() => void mint()} disabled={busy || !wallet || !accountId || !amount.trim()}>{busy ? "Submitting mint…" : "Mint " + state.symbol}</button>
          {!accountId && <p className="muted">Connect the browser wallet that controls the token's mint authority.</p>}
          {txHash && <p className="message success">Submitted: <span className="mono-value">{txHash}</span></p>}
          {message && <p className="message">{message}</p>}
          {error && <p className="message warning">{error}</p>}
        </div>
      </> : <div className="card full mint-empty-state"><span className="eyebrow">HOW IT WORKS</span><h3>Already have a mintable token?</h3><p>Paste its contract above. Neyro will read the live token metadata and supply first; then you choose where to mint and how much to issue.</p><div className="mint-empty-steps"><span><b>1</b> Connect the owner wallet</span><span><b>2</b> Load your token contract</span><span><b>3</b> Enter 1,000 (or any amount)</span><span><b>4</b> Review and sign</span></div></div>}
    </section>
  );
}

function mintMethodLabel(profile: "mint_receiver_id" | "mint_account_id" | "custom", customMethod: string): string {
  if (profile === "mint_receiver_id") return "mint(receiver_id, amount)";
  if (profile === "mint_account_id") return "mint(account_id, amount)";
  return customMethod.trim() || "custom method";
}

function toNearYocto(value: string): bigint {
  const clean = value.trim() || "0";
  if (!/^\d+(?:\.\d+)?$/.test(clean)) throw new Error("Attached deposit must be a valid NEAR amount.");
  const [whole, fraction = ""] = clean.split(".");
  if (fraction.length > 24) throw new Error("Attached deposit supports at most 24 decimals.");
  return BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, "0") || "0");
}


export function MintView({ accountId }: { accountId: string }) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [decimals, setDecimals] = useState("18");
  const [supply, setSupply] = useState("");
  const [recipient, setRecipient] = useState(accountId);
  const [metadata, setMetadata] = useState("");

  useEffect(() => {
    if (!recipient && accountId) setRecipient(accountId);
  }, [accountId, recipient]);

  const validDecimals = /^\d+$/.test(decimals) && Number(decimals) >= 0 && Number(decimals) <= 24;
  const validSupply = /^\d+(?:\.\d+)?$/.test(supply.trim()) && !/^0+(?:\.0+)?$/.test(supply.trim());
  const ready = Boolean(name.trim() && symbol.trim() && validDecimals && validSupply && recipient.trim());

  return (
    <section className="grid terminal-page">
      <div className="card hero full">
        <div>
          <span className="eyebrow">TOKEN / MINT</span>
          <h2>Mint a fresh developer-owned NEP-141 token.</h2>
          <p>
            Mint is the generic token-creation flow, separate from the NEARly launchpad. Define the token identity,
            initial supply and receiving account first; Neyro will only enable deployment once its verified token factory is connected.
          </p>
        </div>
        <div className="hero-state"><span className="status-dot" /><span>Fresh token deployment</span></div>
      </div>

      <div className="card create-token-form">
        <div className="section-head"><div><span className="eyebrow">01 / MINT</span><h3>New token</h3></div><span className="module-status">NEP-141</span></div>

        <div className="two">
          <div className="mint-field"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Protocol Token" maxLength={64} /></div>
          <div className="mint-field"><label>Symbol</label><input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="MPT" maxLength={16} /></div>
        </div>

        <div className="two">
          <div className="mint-field"><label>Decimals</label><input inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value.replace(/[^0-9]/g, ""))} placeholder="18" /><small>Fixed token precision chosen at creation.</small></div>
          <div className="mint-field"><label>Initial supply</label><input inputMode="decimal" value={supply} onChange={(e) => setSupply(e.target.value)} placeholder="1000000" /><small>Whole-token amount. Base units are derived from decimals.</small></div>
        </div>

        <div className="mint-field">
          <label>Initial supply recipient</label>
          <div className="mint-recipient-row"><input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="your-account.near" spellCheck={false} />{accountId && <button type="button" onClick={() => setRecipient(accountId)}>My wallet</button>}</div>
          <small>The mint transaction will create the token and assign its initial supply to this account.</small>
        </div>

        <div className="mint-field">
          <label>Metadata reference <span className="optional">optional</span></label>
          <input value={metadata} onChange={(e) => setMetadata(e.target.value)} placeholder="https://example.com/token.json" spellCheck={false} />
          <small>Metadata handling will be finalized against the deployed token implementation.</small>
        </div>
      </div>

      <div className="card create-token-review">
        <div className="section-head"><div><span className="eyebrow">02 / REVIEW</span><h3>Mint preview</h3></div><span className={ready ? "ready" : "muted"}>{ready ? "Ready" : "Incomplete"}</span></div>

        <div className="mint-review-list">
          <div><span>Name</span><strong>{name || "—"}</strong></div>
          <div><span>Symbol</span><strong>{symbol || "—"}</strong></div>
          <div><span>Initial supply</span><strong>{supply || "—"} {symbol || ""}</strong></div>
          <div><span>Decimals</span><strong>{validDecimals ? decimals : "—"}</strong></div>
          <div><span>Recipient</span><strong>{recipient || "—"}</strong></div>
          <div><span>Metadata</span><strong>{metadata || "Not configured"}</strong></div>
        </div>

        <div className="mint-interface-warning"><strong>Fresh-token deployment is intentionally gated.</strong><span>Neyro does not currently have a verified generic token-mint/factory contract address and interface in this web branch. No guessed contract call is exposed here.</span></div>
        <button className="mint-submit" type="button" disabled={!ready}>Fresh token mint not connected</button>
      </div>
    </section>
  );
}


export function TokenLockView({ accountId }: { accountId: string }) {
  const today = new Date();
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [time, setTime] = useState("12:00");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState("");

  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: firstDay + daysInMonth }, (_, index) => index < firstDay ? null : index - firstDay + 1);

  function selectDay(day: number) {
    const next = new Date(month.getFullYear(), month.getMonth(), day);
    next.setHours(Number(time.slice(0, 2)), Number(time.slice(3, 5)), 0, 0);
    setSelectedDate(next);
    setCalendarOpen(false);
  }

  function changeMonth(offset: number) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  function isBeforeToday(day: number) {
    const candidate = new Date(month.getFullYear(), month.getMonth(), day);
    const floor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return candidate < floor;
  }

  function formatSelected() {
    if (!selectedDate) return "Select unlock date";
    return selectedDate.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  return (
    <section className="grid terminal-page">
      <div className="card hero full">
        <div>
          <span className="eyebrow">TOKEN TOOLS / LOCK</span>
          <h2>Token Locker</h2>
          <p>Lock your tokens until a scheduled unlock date. The calendar only selects the schedule; deployment remains gated until Neyro's verified locker contract is connected.</p>
        </div>
        <div className="hero-state"><span className="status-dot" /><span>Locker deployment gate</span></div>
      </div>

      <div className="card locker-load full">
        <div className="locker-token-select"><span className="locker-token-badge">NEAR</span><span className="locker-token-caret">⌄</span></div>
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Enter token contract or locker address" spellCheck={false} />
        <button className="primary" type="button" disabled={!token.trim()}>LOAD</button>
      </div>

      <div className="card locker-state full">
        <span className="locker-state-icon">⌁</span>
        <strong>Load a token to view</strong>
        <span>Live token balance and existing lockers will appear here when a verified locker protocol is connected.</span>
      </div>

      <div className="card locker-create">
        <div className="section-head">
          <div><span className="eyebrow">01 / LOCK</span><h3>Create Locker</h3></div>
          <span className="module-status">NON-CUSTODIAL</span>
        </div>

        <div className="mint-field">
          <div className="field-row-label"><label>Token Amount</label><span className="locker-balance">Balance —</span></div>
          <div className="amount-max">
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            <button type="button" onClick={() => {}} disabled>MAX</button>
          </div>
        </div>

        <div className="mint-field">
          <label>Unlock Schedule</label>
          <div className="calendar-field">
            <button type="button" className={selectedDate ? "calendar-trigger selected" : "calendar-trigger"} onClick={() => setCalendarOpen((open) => !open)}>
              <span className="calendar-icon">📅</span>
              <span>{formatSelected()}</span>
              <span className="calendar-chevron">⌄</span>
            </button>

            {calendarOpen && (
              <div className="modern-calendar" role="dialog" aria-label="Unlock date calendar">
                <div className="calendar-head">
                  <button type="button" onClick={() => changeMonth(-1)} aria-label="Previous month">‹</button>
                  <strong>{monthLabel}</strong>
                  <button type="button" onClick={() => changeMonth(1)} aria-label="Next month">›</button>
                </div>
                <div className="calendar-weekdays">
                  {["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((day) => <span key={day}>{day}</span>)}
                </div>
                <div className="calendar-grid">
                  {cells.map((day, index) => day === null ? <span key={index} /> : (
                    <button
                      key={day}
                      type="button"
                      className={[
                        selectedDate && selectedDate.getFullYear() === month.getFullYear() && selectedDate.getMonth() === month.getMonth() && selectedDate.getDate() === day ? "selected" : "",
                        new Date().getFullYear() === month.getFullYear() && new Date().getMonth() === month.getMonth() && new Date().getDate() === day ? "today" : ""
                      ].filter(Boolean).join(" ")}
                      disabled={isBeforeToday(day)}
                      onClick={() => selectDay(day)}
                    >
                      {day}
                    </button>
                  ))}
                </div>
                <div className="calendar-time">
                  <label>Unlock time</label>
                  <input type="time" value={time} onChange={(e) => {
                    setTime(e.target.value);
                    if (selectedDate) {
                      const next = new Date(selectedDate);
                      next.setHours(Number(e.target.value.slice(0, 2)), Number(e.target.value.slice(3, 5)), 0, 0);
                      setSelectedDate(next);
                    }
                  }} />
                </div>
                <button type="button" className="calendar-today" onClick={() => {
                  const next = new Date();
                  next.setHours(Number(time.slice(0, 2)), Number(time.slice(3, 5)), 0, 0);
                  setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
                  setSelectedDate(next);
                  setCalendarOpen(false);
                }}>Today</button>
              </div>
            )}
          </div>
        </div>

        <div className="locker-summary">
          <span>Unlock</span>
          <strong>{selectedDate ? selectedDate.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Not scheduled"}</strong>
        </div>

        <div className="mint-interface-warning">
          <strong>Locker deployment is intentionally gated.</strong>
          <span>Neyro does not currently expose a verified generic token-locker contract here. No guessed locker address or lock method is used.</span>
        </div>
        <button className="mint-submit" type="button" disabled={!accountId || !token.trim() || !amount.trim() || !selectedDate}>Create Locker</button>
      </div>

      <div className="card locker-existing">
        <div className="section-head"><div><span className="eyebrow">02 / LOCKERS</span><h3>Existing Lockers</h3></div><span className="module-status">LIVE DATA</span></div>
        <div className="locker-empty">
          <span className="locker-empty-icon">◌</span>
          <strong>No lockers loaded</strong>
          <span>Connect a verified locker protocol to read existing locks.</span>
        </div>
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
    Mint: {
      eyebrow: "TOKEN / MINT",
      title: "Create a fresh developer-owned NEP-141 token.",
      body: "Mint is Neyro's fresh-token creation flow. Define the token identity, decimals, initial supply, recipient and metadata, then deploy through Neyro's verified token implementation when the on-chain factory is connected.",
      details: [
        ["Identity", "Name, symbol and decimals"],
        ["Initial supply", "Created for the selected recipient"],
        ["Deployment", "Enabled only after the Neyro token implementation is verified"]
      ]
    },
    Lock: {
      eyebrow: "TOKEN TOOLS / LOCK",
      title: "Token locking is not a NEARly token operation.",
      body: "NEARly's lock contracts hold launch liquidity positions. They are not a general-purpose token locker and Neyro will not send user tokens into them.",
      details: [
        ["NEARly locker", "Holds the launch Rhea position"],
        ["User tokens", "No supported deposit-to-lock flow"],
        ["Neyro", "No irreversible transfer to an unrelated locker"]
      ]
    },
    Unlock: {
      eyebrow: "TOKEN TOOLS / UNLOCK",
      title: "There is no user-token unlock flow in NEARly.",
      body: "The NEARly liquidity locker has no liquidity withdrawal operation. Neyro therefore does not expose an unlock transaction that could imply a false recovery path.",
      details: [
        ["Liquidity", "Locked by the launch protocol"],
        ["Withdrawal", "No supported locker withdrawal method"],
        ["Safety", "No guessed contract call"]
      ]
    },
    "Contract Call": {
      eyebrow: "DEVELOPER / WRITE",
      title: "Generic contract writes remain intentionally scoped.",
      body: "The terminal exposes verified protocol operations rather than an arbitrary method-and-arguments signer.",
      details: [
        ["Read", "Contract Inspector is live"],
        ["Write", "Protocol-specific builders only"],
        ["Review", "Receiver, method, gas and deposit are explicit"]
      ]
    },
    "Transaction Builder": {
      eyebrow: "DEVELOPER / BUILDER",
      title: "Transaction building uses verified action primitives.",
      body: "Arbitrary contract execution is not presented as a safe generic form. Supported operations are built from explicit receiver, method, gas and deposit values.",
      details: [
        ["Actions", "FunctionCall and Transfer"],
        ["Validation", "Gas, deposit and argument bounds"],
        ["Wallet", "Browser signing only"]
      ]
    },
    "Token Operations": {
      eyebrow: "TOKEN TOOLS / HISTORY",
      title: "Token operation history comes from real execution records.",
      body: "No synthetic token transactions are shown. Confirmed operations can be persisted and reconciled before appearing in history.",
      details: [
        ["Source", "Browser execution state"],
        ["Status", "Submitted, confirmed, failed or unknown"],
        ["Safety", "Unknown transactions are reconciled before retry"]
      ]
    },
    Swap: {
      eyebrow: "TRADE / SWAP",
      title: "Swap quotes are live; execution is the remaining signing gate.",
      body: "Neyro already reads live RHEA routes. The final execution path must handle token registration, wrapping and multi-action reconciliation before signing is enabled.",
      details: [
        ["Quote", "Live RHEA SmartRouter response"],
        ["Controls", "Slippage, expiry and minimum received"],
        ["Execution", "Browser signing after lifecycle verification"]
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
      <span className="module-status">Protocol behavior verified</span>
      <div className="module-details">
        {copy.details.map(([title, body]) => (
          <div className="module-detail" key={title}>
            <strong>{title}</strong>
            <span>{body}</span>
          </div>
        ))}
      </div>
      <div className="action-row">
        {view === "Create token" && <button className="primary" onClick={() => onNavigate("Launch NEARly token")}>Open NEARly launch</button>}
        {view === "Burn" && <button className="primary" onClick={() => onNavigate("Burn")}>Open burn tool</button>}
      </div>
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
