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
