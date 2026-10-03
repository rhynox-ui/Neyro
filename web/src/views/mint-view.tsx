import { useEffect, useMemo, useState } from "react";
import { NearRpcClient } from "../near/rpc";
import { getFtMetadata } from "../near/ft";
import type { WebWalletConnector } from "../wallet/connector";
import { TOKEN_TOOL_FEE_RECIPIENT } from "../token-tools/fee-recipient";
import {
  buildTokenArgs,
  buildTokenCreationTransactions,
  MAX_ICON_DATA_URL_BYTES,
  parseSupply,
  quoteTokenCreation,
  TOKEN_FACTORIES,
  tokenAccountId,
  validateTokenDraft,
  type FactoryQuote,
  type TokenDraft
} from "../token-tools/token-factory";

const ICON_SIZE = 96;

function formatYocto(value: bigint): string {
  const divisor = 10n ** 24n;
  const fraction = (value % divisor).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return `${(value / divisor).toString()}${fraction ? `.${fraction}` : ""} NEAR`;
}

/**
 * Downscales an uploaded image to a small square data URL. The icon is stored
 * on-chain inside the token metadata and paid for by the factory deposit, so
 * it must stay small. Data URLs also satisfy the site CSP (no blob: images).
 */
async function iconDataUrl(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Logo must be PNG, JPG or WEBP.");
  }
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the logo file."));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Logo could not be decoded."));
    element.src = source;
  });
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Logo resizing is unavailable in this browser.");
  const side = Math.min(image.width, image.height);
  context.drawImage(
    image,
    (image.width - side) / 2, (image.height - side) / 2, side, side,
    0, 0, ICON_SIZE, ICON_SIZE
  );
  for (const [type, quality] of [["image/webp", 0.85], ["image/webp", 0.6], ["image/png", undefined]] as const) {
    const url = canvas.toDataURL(type, quality);
    if (url.startsWith(`data:${type}`) && url.length <= MAX_ICON_DATA_URL_BYTES) return url;
  }
  throw new Error("Logo is too detailed to store on-chain; use a simpler image.");
}

type Phase =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "signing" }
  | { kind: "confirming"; createHash?: string; feeHash?: string }
  | { kind: "created"; tokenId: string; createHash?: string; feeHash?: string }
  | { kind: "error"; message: string };

export function MintView({
  accountId,
  wallet
}: {
  accountId: string;
  wallet: WebWalletConnector | null;
}) {
  const [factoryId, setFactoryId] = useState(TOKEN_FACTORIES[0].accountId);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [decimals, setDecimals] = useState("18");
  const [supply, setSupply] = useState("");
  const [owner, setOwner] = useState(accountId);
  const [icon, setIcon] = useState<string | undefined>();
  const [iconError, setIconError] = useState("");
  const [quote, setQuote] = useState<FactoryQuote | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    if (!owner && accountId) setOwner(accountId);
  }, [accountId, owner]);

  const draft = useMemo<{ value: TokenDraft | null; problems: string[] }>(() => {
    const parsedDecimals = /^\d+$/.test(decimals) ? Number(decimals) : NaN;
    let totalSupplyBase = 0n;
    const problems: string[] = [];
    if (supply.trim()) {
      try {
        totalSupplyBase = parseSupply(supply, Number.isNaN(parsedDecimals) ? 0 : parsedDecimals);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : "Invalid supply.");
      }
    }
    const value: TokenDraft = {
      ownerId: owner.trim().toLowerCase(),
      name,
      symbol,
      decimals: parsedDecimals,
      totalSupplyBase,
      icon
    };
    problems.push(...validateTokenDraft(value, factoryId));
    return { value: problems.length === 0 ? value : null, problems };
  }, [decimals, factoryId, icon, name, owner, supply, symbol]);

  // Any input change invalidates a live quote.
  useEffect(() => {
    setQuote(null);
    setPhase((current) => (current.kind === "error" || current.kind === "idle" ? { kind: "idle" } : current));
  }, [draft.value, factoryId]);

  const predictedAccount = symbol.trim() ? tokenAccountId(symbol, factoryId) : "";
  const busy = phase.kind === "quoting" || phase.kind === "signing" || phase.kind === "confirming";

  async function handleIcon(file: File | undefined) {
    setIconError("");
    if (!file) return;
    try {
      setIcon(await iconDataUrl(file));
    } catch (error) {
      setIcon(undefined);
      setIconError(error instanceof Error ? error.message : "Logo could not be prepared.");
    }
  }

  async function check() {
    if (!draft.value || !accountId) return;
    setPhase({ kind: "quoting" });
    try {
      const next = await quoteTokenCreation(
        new NearRpcClient(), factoryId, accountId, buildTokenArgs(draft.value)
      );
      setQuote(next);
      setPhase({ kind: "idle" });
    } catch (error) {
      setQuote(null);
      setPhase({
        kind: "error",
        message: `${factoryId} did not answer the factory interface check: ${error instanceof Error ? error.message : "unknown error"}. Creation stays disabled.`
      });
    }
  }

  async function create() {
    if (!wallet || !accountId || !draft.value || !quote) return;
    setPhase({ kind: "signing" });
    const rpc = new NearRpcClient();
    try {
      // Fresh quote immediately before signing: the symbol could have been
      // taken or the required deposit changed since the user checked.
      const fresh = await quoteTokenCreation(rpc, factoryId, accountId, buildTokenArgs(draft.value));
      setQuote(fresh);
      if (!fresh.symbolAvailable) throw new Error(`${fresh.tokenAccountId} already exists.`);
      if (!fresh.sufficientBalance) throw new Error("Wallet balance no longer covers the creation cost.");

      const transactions = buildTokenCreationTransactions(
        accountId, factoryId, buildTokenArgs(draft.value), fresh.storageDeposit
      );
      const [createResult, feeResult] = await wallet.signAndSendMany(transactions);
      setPhase({ kind: "confirming", createHash: createResult?.transactionHash, feeHash: feeResult?.transactionHash });

      if (createResult?.transactionHash) {
        await rpc.transactionStatus(createResult.transactionHash, accountId);
      }
      // The token contract answering ft_metadata is the proof of creation.
      const metadata = await getFtMetadata(rpc, fresh.tokenAccountId);
      if (metadata.symbol !== draft.value.symbol.trim()) {
        throw new Error(`${fresh.tokenAccountId} exists but reports symbol ${metadata.symbol}.`);
      }
      setPhase({
        kind: "created",
        tokenId: fresh.tokenAccountId,
        createHash: createResult?.transactionHash,
        feeHash: feeResult?.transactionHash
      });
    } catch (error) {
      setPhase({
        kind: "error",
        message: `${error instanceof Error ? error.message : "Token creation stopped."} Check your wallet activity before trying again; a submitted transaction is never resent automatically.`
      });
    }
  }

  const canCreate = Boolean(
    wallet && accountId && draft.value && quote?.symbolAvailable && quote.sufficientBalance && !busy
  );

  return (
    <section className="grid terminal-page mint-layout">
      <div className="card create-token-form">
        <div className="section-head">
          <div><span className="eyebrow">01 / IDENTITY</span><h3>Token details</h3></div>
          <span className="module-status">NEP-141 · NEP-148</span>
        </div>

        <div className="two">
          <div className="mint-field">
            <label htmlFor="mint-name">Name</label>
            <input id="mint-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Protocol Token" maxLength={64} />
          </div>
          <div className="mint-field">
            <label htmlFor="mint-symbol">Symbol</label>
            <input id="mint-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="MPT" maxLength={24} />
            <small>{predictedAccount ? <>Token contract: <span className="mono-value">{predictedAccount}</span></> : "Letters and digits only. It becomes the token's account id."}</small>
          </div>
        </div>

        <div className="mint-field">
          <label>Logo <span className="optional">optional · stored on-chain</span></label>
          <div className="logo-upload-row">
            <div className="token-logo-preview">{icon ? <img src={icon} alt="Token logo preview" /> : <span>{symbol.slice(0, 2) || "TK"}</span>}</div>
            <label className="upload-button">Upload image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => void handleIcon(e.target.files?.[0])} /></label>
            {icon && <button type="button" onClick={() => setIcon(undefined)}>Remove</button>}
          </div>
          <small className={iconError ? "warning" : undefined}>{iconError || `Cropped to ${ICON_SIZE}×${ICON_SIZE} and kept under ${MAX_ICON_DATA_URL_BYTES / 1024} KB; a larger logo raises the storage deposit.`}</small>
        </div>

        <div className="section-head section-gap">
          <div><span className="eyebrow">02 / SUPPLY</span><h3>Supply & owner</h3></div>
        </div>
        <div className="two">
          <div className="mint-field">
            <label htmlFor="mint-supply">Total supply</label>
            <input id="mint-supply" inputMode="decimal" value={supply} onChange={(e) => setSupply(e.target.value)} placeholder="1000000000" />
            <small>Minted once, in full, at creation.</small>
          </div>
          <div className="mint-field">
            <label htmlFor="mint-decimals">Decimals</label>
            <input id="mint-decimals" inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value.replace(/[^0-9]/g, ""))} placeholder="18" />
            <small>18 or 24 are common on NEAR.</small>
          </div>
        </div>
        <div className="mint-field">
          <label htmlFor="mint-owner">Supply recipient</label>
          <div className="mint-recipient-row">
            <input id="mint-owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="your-account.near" spellCheck={false} />
            {accountId && <button type="button" onClick={() => setOwner(accountId)}>My wallet</button>}
          </div>
        </div>

        <div className="section-head section-gap">
          <div><span className="eyebrow">03 / DEPLOYMENT</span><h3>Factory</h3></div>
        </div>
        <div className="mint-field">
          <label htmlFor="mint-factory">Token factory</label>
          <select id="mint-factory" value={factoryId} onChange={(e) => setFactoryId(e.target.value)}>
            {TOKEN_FACTORIES.map((factory) => <option key={factory.accountId} value={factory.accountId}>{factory.label}</option>)}
          </select>
          <small>Deploys the canonical NEAR fungible-token contract. The factory's own views are checked live before signing.</small>
        </div>

        <div className="mint-facts">
          <div><strong>Fixed supply</strong><span>No one can mint more later.</span></div>
          <div><strong>No freeze or tax</strong><span>Standard NEP-141 transfers only.</span></div>
          <div><strong>You own it all</strong><span>The full supply goes to the recipient.</span></div>
        </div>
      </div>

      <aside className="card create-token-review mint-summary">
        <div className="token-preview">
          <div className="token-logo-preview large">{icon ? <img src={icon} alt="" /> : <span>{symbol.slice(0, 2) || "TK"}</span>}</div>
          <div>
            <strong>{name || "Token name"}</strong>
            <span>{symbol || "SYMBOL"} · {decimals || "—"} decimals</span>
          </div>
        </div>
        <div className="mint-review-list">
          <div><span>Total supply</span><strong>{supply || "—"} {symbol}</strong></div>
          <div><span>Contract</span><strong className="mono-value">{predictedAccount || "—"}</strong></div>
          <div><span>Recipient</span><strong>{owner || "—"}</strong></div>
          <div><span>Symbol available</span><strong className={quote ? (quote.symbolAvailable ? "ready" : "warning") : undefined}>{quote ? (quote.symbolAvailable ? "Yes" : "Taken") : "Not checked"}</strong></div>
          <div><span>Storage deposit</span><strong>{quote ? formatYocto(quote.storageDeposit) : "—"}</strong></div>
          <div><span>Neyro fee</span><strong>{quote ? formatYocto(quote.serviceFee) : "1 NEAR"}</strong></div>
          <div><span>Max gas</span><strong>{quote ? formatYocto(quote.gasCeiling) : "—"}</strong></div>
          <div><span>Total up to</span><strong>{quote ? formatYocto(quote.totalRequired) : "—"}</strong></div>
          <div><span>Spendable balance</span><strong className={quote && !quote.sufficientBalance ? "warning" : undefined}>{quote ? formatYocto(quote.availableBalance) : "—"}</strong></div>
        </div>

        {draft.problems.length > 0 && (name || symbol || supply) && (
          <ul className="mint-problems">{draft.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
        )}

        {!accountId ? (
          <button className="mint-submit" type="button" disabled>Connect wallet to create</button>
        ) : !quote ? (
          <button className="mint-submit primary" type="button" onClick={() => void check()} disabled={!draft.value || busy}>
            {phase.kind === "quoting" ? "Checking factory…" : "Check availability & cost"}
          </button>
        ) : (
          <button className="mint-submit primary" type="button" onClick={() => void create()} disabled={!canCreate}>
            {phase.kind === "signing" ? "Approve in wallet…" : phase.kind === "confirming" ? "Confirming…" : "Create token"}
          </button>
        )}
        <small>One wallet approval sends two transactions: the factory call, then the 1 NEAR fee to {TOKEN_TOOL_FEE_RECIPIENT}. You pay network gas.</small>

        {phase.kind === "error" && <div className="mint-interface-warning"><strong>Stopped</strong><span>{phase.message}</span></div>}
        {phase.kind === "confirming" && <div className="mint-interface-status">Waiting for {phase.createHash ?? "the transaction"} to finalize…</div>}
        {phase.kind === "created" && (
          <div className="mint-interface-status">
            <strong>Token created: {phase.tokenId}</strong>
            <a href={`https://nearblocks.io/address/${phase.tokenId}`} target="_blank" rel="noreferrer">View on NearBlocks</a>
            {phase.createHash && <span className="mono-value">Create tx {phase.createHash}</span>}
            {phase.feeHash
              ? <span className="mono-value">Fee tx {phase.feeHash}</span>
              : <span>The wallet did not return the fee transaction hash. Check your wallet activity before sending anything else.</span>}
          </div>
        )}
      </aside>
    </section>
  );
}
