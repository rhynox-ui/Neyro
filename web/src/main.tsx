import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { formatTokenToolFee } from "./token-tools/fees";
import { TOKEN_TOOL_FEE_RECIPIENT } from "./token-tools/fee-recipient";
import { NearRpcClient } from "./near/rpc";
import { preflightSenders, type CampaignPreflight } from "./preflight";

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
  const base = BigInt(parts[0]) * 10n ** BigInt(decimals) +
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
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
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
  const [token, setToken] = useState("");
  const [decimals, setDecimals] = useState("24");
  const [defaultAmount, setDefaultAmount] = useState("");
  const [senders, setSenders] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [message, setMessage] = useState("Upload a recipient file to build the campaign.");
  const [preflight, setPreflight] = useState<CampaignPreflight | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);

  const senderList = useMemo(
    () => senders.split(/\r?\n/).map((v) => v.trim().toLowerCase()).filter(Boolean),
    [senders]
  );

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

  async function upload(file: File) {
    setBusy(true);
    setPlan(null);
    setFileName(file.name);
    setProcessed(0);
    setMessage("Streaming and validating recipients…");

    try {
      const result = await parseFile(
        file,
        Number(decimals),
        defaultAmount,
        setProcessed
      );
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
        <div className="brand"><b>N</b><div><strong>NEYRO</strong><small>TERMINAL</small></div></div>
        <nav>
          <button className="nav active">Overview</button>
          <button className="nav">Trade</button>
          <button className="nav">Launch</button>
          <button className="nav">Token Tools</button>
          <button className="nav">Airdrops</button>
          <button className="nav">History</button>
        </nav>
        <div className="wallet-box">
          <span>WEB WALLET</span>
          <strong>Not connected</strong>
          <small>Browser-wallet signing is kept separate from Telegram custody.</small>
          <button disabled>Connect wallet</button>
        </div>
      </aside>

      <main>
        <header>
          <div><span className="eyebrow">NEAR MAINNET</span><h1>Bulk Airdrop</h1></div>
          <span className="pill">Foundation build</span>
        </header>

        <section className="grid">
          <div className="card hero">
            <div>
              <span className="eyebrow">MULTI-SENDER</span>
              <h2>Bulk send any NEP-141 token.</h2>
              <p>
                Upload a large recipient list, validate it locally, remove duplicates,
                calculate the exact token requirement and prepare resumable batches.
              </p>
            </div>
            <div className="tool-fees">
              <span className="badge">Mint fee: {formatTokenToolFee("mint")}</span>
              <span className="badge">Lock fee: {formatTokenToolFee("lock")}</span>
              <span className="badge">Fees → {TOKEN_TOOL_FEE_RECIPIENT}</span>
            </div>
          </div>

          <div className="card">
            <label>Token contract</label>
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="token.near" />
            <div className="two">
              <div><label>Decimals</label><input type="number" min="0" max="24" value={decimals} onChange={(e) => setDecimals(e.target.value)} /></div>
              <div><label>Default amount</label><input value={defaultAmount} onChange={(e) => setDefaultAmount(e.target.value)} placeholder="1000" /></div>
            </div>
          </div>

          <div className="card">
            <label>Sender pool</label>
            <textarea value={senders} onChange={(e) => setSenders(e.target.value)} rows={5} placeholder={"sender-a.near\nsender-b.near\nsender-c.near"} />
            <small>Later the executor will verify each sender balance and allocate batches deterministically.</small>
          </div>

          <div className="card full">
            <div className="row-title"><div><label>Recipients</label><h3>{fileName || "No file selected"}</h3></div><span className="muted">CSV / TXT / JSON</span></div>
            <label className="drop">
              <input type="file" accept=".csv,.txt,.json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
              <b>Upload recipient file</b>
              <span>CSV/TXT uses streaming parsing and is the preferred format for very large lists.</span>
            </label>
            {busy && <div className="progress"><div style={{ width: Math.min(100, processed / Math.max(processed, 1) * 100) + "%" }} /></div>}
            <p className="message">{message}</p>
          </div>

          {plan && <>
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
              <p className="muted">Token: {token || "not specified"} · Sender accounts: {senderList.length}</p>
            </div>

            <div className="card full">
              <div className="row-title"><div><span className="eyebrow">PREVIEW</span><h3>First {preview.length} valid recipients</h3></div><button disabled>Start airdrop</button></div>
              <div className="table-wrap">
                <table><thead><tr><th>#</th><th>Wallet</th><th>Amount</th><th>Status</th></tr></thead>
                  <tbody>{preview.map((row) => <tr key={row.line + row.wallet}><td>{row.line}</td><td>{row.wallet}</td><td>{row.amount}</td><td className="ready">Valid</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          </>}
        </section>

        <footer>
          This web app is isolated from the Telegram bot. It does not import Telegram handlers,
          encrypted signer storage, Telegram wallet services, or the Worker entrypoint.
        </footer>
      </main>
    </div>
  );
}

function Stat({ name, value }: { name: string; value: string }) {
  return <div className="card stat"><span>{name}</span><strong>{value}</strong></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
