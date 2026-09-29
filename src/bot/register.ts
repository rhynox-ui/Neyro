import { InlineKeyboard, type Bot, type Context } from "grammy";
import { mainMenu } from "./menu.js";
import { MAX_WALLETS, WalletService } from "../wallet/service.js";
import { getNearBalance, type NearBalance } from "../near/account.js";
import { ftBalanceOf } from "../near/ft.js";
import { functionCall } from "../near/actions.js";
import { NearAccountSigner } from "../wallet/near-account-signer.js";

const WRAPPED_NEAR = "wrap.near";
import { formatUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { TradingService } from "../trading/service.js";
import { PortfolioService, type PortfolioAsset } from "../portfolio/service.js";
import type { ExecutionResult } from "../trading/service.js";
import { config } from "../config.js";
import { userMessage } from "../errors.js";
import { RateLimiter } from "./rate-limit.js";
import { deleteIncoming, keepScreen, replyNotice, replyScreen } from "./screens.js";
import { scheduleDeletion } from "./autodelete.js";
import type { WalletSummary } from "../wallet/repository.js";
import { WithdrawService, formatWithdrawAmount, type WithdrawPlan, type WithdrawResult } from "../wallet/withdraw.js";
import { describeRoute, valueLossWarning } from "../trading/outcome.js";
import { ageLabel, createTokenPanel, feeLabel, SLIPPAGE_PRESETS } from "./panel.js";
import { SettingsService, type SlippagePrefs } from "../settings/service.js";
import { fetchLaunch, fetchRecentLaunches, type NearlyLaunch } from "../discovery/nearly.js";

const walletService = new WalletService();
const tradingService = new TradingService(walletService);
const portfolioService = new PortfolioService();
const withdrawService = new WithdrawService(walletService, (query) => tradingService.resolveToken(query));
const settingsService = new SettingsService();
/** Key exports per user: 3 per hour. */
const keyExports = new RateLimiter(3, 60 * 60 * 1000);
const tokenPanel = createTokenPanel({ tradingService, walletService, settings: settingsService, renderExecution: (result) => renderExecution(result) });

const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const code = (text: string) => `<code>${escapeHtml(text)}</code>`;

export function formatNear(yocto: bigint): string {
  return formatUnits(yocto.toString(), 24);
}

export function explorerTx(txHash: string): string {
  const host = config.NEAR_NETWORK === "mainnet" ? "nearblocks.io" : "testnet.nearblocks.io";
  return `https://${host}/txns/${txHash}`;
}

/** Full transaction hashes (tap to copy) with explorer links. */
export function renderTxHashes(hashes: readonly string[]): string {
  if (hashes.length === 0) return "";
  const lines = hashes.map((hash, i) => {
    const label = hashes.length > 1 ? `Tx ${i + 1}` : "Tx hash";
    return `🔗 <b>${label}:</b>\n${code(hash)}\n<a href="${explorerTx(hash)}">View on NearBlocks</a>`;
  });
  return `\n\n${lines.join("\n\n")}`;
}

/** HTML message for a trade outcome. */
export function renderExecution(result: ExecutionResult): string {
  const txs = renderTxHashes(result.txHashes);
  const reason = result.reason ? escapeHtml(result.reason) : undefined;
  switch (result.status) {
    case "filled": {
      const fee = result.fee
        ? `\n\n🧾 <b>Fee:</b> ${escapeHtml(result.fee.display)}\n<a href="${explorerTx(result.fee.txHash)}">View fee on NearBlocks</a>`
        : "";
      return `✅ <b>Trade filled</b>${txs}${fee}`;
    }
    case "submitted":
      return `✅ <b>Trade executed on chain.</b> Fill could not be verified yet; check /portfolio.${txs}`;
    case "reverted":
      return `↩️ <b>Trade did not fill.</b> ${reason ?? "The swap failed on chain"}.\nYour tokens were not exchanged and no fee was charged; only gas (and any storage deposit) was spent.${txs}`;
    case "partial":
      return `⚠️ <b>Trade partially executed.</b> Some transactions were rejected; check /portfolio before retrying.${txs}`;
    case "unknown":
      return `⏳ <b>Trade status unknown.</b> The transaction may still land. <b>Do not retry</b>; check the explorer link.${txs}`;
    case "failed":
      return `❌ <b>Trade failed before reaching the chain.</b> Nothing was spent; you can retry.${reason ? `\n\n${reason}` : ""}`;
  }
}

export function renderWithdrawConfirm(plan: WithdrawPlan): string {
  return [
    "📤 <b>Confirm withdrawal</b>",
    "",
    `Amount: ${escapeHtml(formatWithdrawAmount(plan))}`,
    `To: ${code(plan.to)}`,
    ...(plan.asset.kind === "ft" ? [`Token: ${code(plan.asset.contractId)}`] : []),
    ...(plan.registration > 0n ? [`Receiver registration: ${formatNear(plan.registration)} NEAR (one time, for this token)`] : []),
    "",
    "⚠️ Check the address carefully. NEAR transfers can't be reversed. Don't send to an exchange deposit address that needs a memo."
  ].join("\n");
}

export function renderWithdrawResult(plan: Pick<WithdrawPlan, "asset" | "amount" | "to">, result: WithdrawResult): string {
  const txs = renderTxHashes(result.txHashes);
  switch (result.status) {
    case "executed":
      return `✅ <b>Sent ${escapeHtml(formatWithdrawAmount(plan))}</b> to ${code(plan.to)}${txs}`;
    case "unknown":
      return `⏳ <b>Withdrawal status unknown.</b> It may still land. <b>Do not retry</b>; check the explorer link.${txs}`;
    case "failed":
      return "❌ <b>Withdrawal failed before reaching the chain.</b> Nothing was sent; you can retry.";
    default:
      return `❌ <b>Withdrawal failed on chain.</b> ${result.reason ? escapeHtml(result.reason) : ""}${txs}`;
  }
}

export function renderSettings(prefs: SlippagePrefs) {
  const text = [
    "⚙️ <b>Settings</b>",
    "",
    `🟢 Buy slippage: ${prefs.buy}%`,
    `🔴 Sell slippage: ${prefs.sell}%`,
    `💸 Protocol fee: ${feeLabel()}`,
    "",
    "Slippage is the most the price may move against you before a trade is cancelled. Higher helps thin meme pools fill; lower protects you from bad prices. You can also set a custom value on any token panel."
  ].join("\n");
  const keyboard = new InlineKeyboard();
  for (const side of ["buy", "sell"] as const) {
    if (side === "sell") keyboard.row();
    keyboard.text(side === "buy" ? "🟢 Buy" : "🔴 Sell", "st:noop");
    for (const value of SLIPPAGE_PRESETS) {
      keyboard.text(`${value}%${prefs[side] === value ? " ✓" : ""}`, `st:${side}:${value}`);
    }
  }
  return { text, keyboard };
}

export function shortAccount(accountId: string): string {
  return accountId.length > 20 ? `${accountId.slice(0, 6)}…${accountId.slice(-4)}` : accountId;
}

/** Wallet list with the active one marked, plus switch / new buttons. */
/** "1.2346 NEAR" (at most 4 decimals), for compact lists and buttons. */
export function shortNear(yocto: bigint): string {
  const value = Number(yocto) / 1e24;
  return `${value.toFixed(4).replace(/\.?0+$/, "")} NEAR`;
}

function usdSuffix(yocto: bigint, nearUsd: number | null): string {
  if (!nearUsd || yocto <= 0n) return "";
  const usd = (Number(yocto) / 1e24) * nearUsd;
  return ` (~$${usd < 1 ? usd.toFixed(2) : usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
}

/**
 * Every wallet with its NEAR balance; `balances[i]` is null when it couldn't
 * be read. The active wallet also shows storage held and its full address.
 */
export function renderWalletScreen(
  wallets: readonly WalletSummary[],
  balances: readonly (NearBalance | null)[],
  maxWallets: number,
  nearUsd: number | null = null,
  /** wNEAR held by the active wallet (e.g. left by a sell or a refunded buy). */
  wrapped = 0n
) {
  const activeIndex = Math.max(0, wallets.findIndex((wallet) => wallet.active));
  const active = wallets[activeIndex];
  const activeBalance = balances[activeIndex] ?? null;
  const balanceLine = (balance: NearBalance | null) =>
    !balance ? "balance unavailable"
      : !balance.exists ? "0 NEAR (not funded yet)"
        : `${shortNear(balance.available)}${usdSuffix(balance.available, nearUsd)}`;

  const lines = wallets.flatMap((wallet, index) => [
    `${wallet.active ? "✅" : "▫️"} W${index + 1} · ${code(shortAccount(wallet.accountId))}`,
    `     💰 ${balanceLine(balances[index] ?? null)}`
  ]);
  const text = [
    `👛 <b>Your wallets</b> (${wallets.length}/${maxWallets})`,
    "",
    ...lines,
    "",
    `Active: ${active ? code(active.accountId) : "—"}`,
    `Balance: ${activeBalance ? renderBalance(activeBalance) + usdSuffix(activeBalance.available, nearUsd) : "unavailable, tap Refresh"}`,
    ...(wrapped > 0n
      ? [`🔁 Plus ${shortNear(wrapped).replace(" NEAR", " wNEAR")}${usdSuffix(wrapped, nearUsd)}: wrapped NEAR from trades. Tap Unwrap to turn it back into NEAR.`]
      : []),
    "",
    "Trades, /deposit and /withdraw use the active wallet. Tap a wallet to switch."
  ].join("\n");

  const keyboard = new InlineKeyboard();
  wallets.forEach((wallet, index) => {
    if (index > 0) keyboard.row();
    const balance = balances[index];
    const amount = balance ? ` · ${balance.exists ? shortNear(balance.available) : "0 NEAR"}` : "";
    keyboard.text(`${wallet.active ? "✅ " : ""}W${index + 1} · ${shortAccount(wallet.accountId)}${amount}`, `w:use:${index}`);
  });
  if (wrapped > 0n) keyboard.row().text(`🔁 Unwrap ${shortNear(wrapped).replace(" NEAR", " wNEAR")} → NEAR`, "w:unwrap");
  keyboard.row().text("🔄 Refresh", "w:refresh");
  if (wallets.length < maxWallets) keyboard.text("➕ New wallet", "w:new");
  keyboard.row().text("🔑 Export private key", "w:export");
  return { text, keyboard };
}

/** The key message stays 24h (Telegram lets bots delete messages up to 48h old). */
export const KEY_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
/** A reminder to save the key is sent this long before it is deleted. */
export const KEY_REMINDER_BEFORE_MS = 60 * 60 * 1000;

export const KEY_REMINDER_TEXT = [
  "⏳ <b>Reminder: your private key message will be deleted in 1 hour.</b>",
  "",
  "If you haven't saved it yet, do it now: write it down or store it in a password manager.",
  "You can export it again anytime from /wallet."
].join("\n");

export function renderExportWarning(accountId: string): string {
  return [
    "🔑 <b>Export private key</b>",
    "",
    `Wallet: ${code(accountId)}`,
    "",
    "⚠️ Anyone who has this key controls this wallet and can take all its funds.",
    "• Never share it, paste it into websites or send it to anyone.",
    "• Neyro will never ask you for it.",
    "• Store it offline, e.g. written down or in a password manager.",
    "",
    "The key message stays for 24 hours, then deletes itself. You'll get a reminder 1 hour before."
  ].join("\n");
}

export function renderPrivateKey(accountId: string, privateKey: string): string {
  return [
    "🔑 <b>Your private key</b>",
    "",
    `Wallet: ${code(accountId)}`,
    `Key (tap to reveal): <tg-spoiler>${code(privateKey)}</tg-spoiler>`,
    "",
    "Import it in Meteor Wallet, HOT Wallet or MyNearWallet with \"Import private key\".",
    "",
    "💾 Save your key now: write it down or store it in a password manager.",
    "🕒 This message deletes itself in 24 hours (reminder 1 hour before)."
  ].join("\n");
}

export function renderBalance(balance: NearBalance): string {
  if (!balance.exists) return "0 NEAR (not funded yet)";
  const held = balance.total - balance.available;
  return held > 0n
    ? `${formatNear(balance.available)} NEAR available (${formatNear(held)} held for storage)`
    : `${formatNear(balance.available)} NEAR`;
}

export function renderPortfolio(near: NearBalance, assets: readonly PortfolioAsset[]): string {
  const lines = assets.map((asset) =>
    `• ${escapeHtml(asset.balance)} <b>${escapeHtml(asset.symbol)}</b> ${code(asset.contractId)}`
  );
  return [
    "💼 <b>Portfolio</b>",
    "",
    `• ${renderBalance(near)}`,
    ...(lines.length ? lines : ["No token balances yet."])
  ].join("\n");
}

function pairName(quote: string): string {
  return quote === "wrap.near" ? "NEAR" : quote.split(".")[0]!.toUpperCase().slice(0, 12);
}

/** HTML list of recent NEARly launches plus one button per token. */
export function renderLaunchFeed(launches: readonly NearlyLaunch[], now = Date.now()) {
  const lines = launches.map((launch, index) =>
    `${index + 1}. <b>${escapeHtml(launch.name)}</b> ($${escapeHtml(launch.symbol)}) · ${ageLabel(launch.createdAtMs, now)} · vs ${escapeHtml(pairName(launch.quote))}\n   ${code(launch.token)}`
  );
  const text = [
    "🆕 <b>New on NEARly</b>",
    "",
    ...(lines.length ? lines : ["No completed launches yet."]),
    "",
    "Tap a token to open its trading panel."
  ].join("\n");

  const keyboard = new InlineKeyboard();
  launches.forEach((launch, index) => {
    keyboard.text(`$${launch.symbol}`, `nl:${launch.id}`);
    if (index % 2 === 1) keyboard.row();
  });
  keyboard.row().text("🔄 Refresh", "nl:feed");
  return { text, keyboard };
}

async function showLaunchFeed(ctx: Context, edit: boolean) {
  try {
    const { text, keyboard } = renderLaunchFeed(await fetchRecentLaunches(8));
    const options = { ...HTML, reply_markup: keyboard };
    if (edit) {
      await ctx.editMessageText(text, options).catch((error) => {
        if (!String(error?.description ?? error).includes("message is not modified")) throw error;
      });
    } else {
      await replyScreen(ctx, "feed", text, options);
    }
  } catch (error) {
    console.error("NEARly feed error:", error);
    await replyNotice(ctx, "❌ New launches are temporarily unavailable. Try again shortly.");
  }
}

async function requireWallet(ctx: Context) {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    await replyNotice(ctx, "❌ Telegram user identity is unavailable.");
    return undefined;
  }
  const wallet = await walletService.getWallet(telegramUserId);
  if (!wallet) {
    await replyNotice(ctx, "👛 No wallet yet. Use /wallet to create one.");
    return undefined;
  }
  return wallet;
}

async function showPortfolio(ctx: Context) {
  const wallet = await requireWallet(ctx);
  if (!wallet) return;
  try {
    const [near, assets] = await Promise.all([
      getNearBalance(wallet.accountId),
      portfolioService.getPortfolio(wallet.accountId)
    ]);
    await replyScreen(ctx, "portfolio", renderPortfolio(near, assets), HTML);
  } catch (error) {
    console.error("Portfolio error:", error);
    await replyNotice(ctx, "❌ Portfolio is temporarily unavailable. Try again shortly.");
  }
}

export function registerBotHandlers(bot: Bot) {
  // A custodial trading bot must never act on messages in group chats.
  bot.chatType(["group", "supergroup", "channel"]).on("message", async (ctx) => {
    if (ctx.message.text?.startsWith("/")) {
      await ctx.reply("🔒 Neyro only works in a private chat.");
    }
  });

  const pm = bot.chatType("private");

  // Remove the user's own commands once handled, so the chat keeps only
  // the bot's current screens and results.
  pm.use(async (ctx, next) => {
    await next();
    if (ctx.message?.text?.startsWith("/")) await deleteIncoming(ctx);
  });

  pm.command("start", async (ctx) => {
    await replyScreen(ctx, "menu", "⚡ Neyro\n\nNEAR trading terminal.\n\nChoose an action:", { reply_markup: mainMenu() });
  });

  async function showWallet(ctx: Context, edit = false, note?: string) {
    const telegramUserId = ctx.from!.id;
    try {
      let created: string | undefined;
      if (!(await walletService.getWallet(telegramUserId))) {
        created = (await walletService.createWallet(telegramUserId)).accountId;
      }
      const wallets = await walletService.listWallets(telegramUserId);
      const active = wallets.find((wallet) => wallet.active) ?? wallets[0]!;
      const [balances, nearUsd, wrapped] = await Promise.all([
        Promise.all(wallets.map((wallet) => getNearBalance(wallet.accountId).catch(() => null))),
        tradingService.nearUsdPrice().catch(() => null),
        ftBalanceOf(WRAPPED_NEAR, active.accountId).catch(() => 0n)
      ]);
      const { text, keyboard } = renderWalletScreen(wallets, balances, MAX_WALLETS, nearUsd, wrapped);
      const header = note ?? (created ? "✅ <b>Wallet created</b>\n\n" : "");
      const body = header + text + (created
        ? "\n\n🔑 Back up this wallet: tap \"Export private key\" below and store the key somewhere safe."
        : "");
      const options = { ...HTML, reply_markup: keyboard };
      if (edit) await ctx.editMessageText(body, options).catch(() => replyScreen(ctx, "wallet", body, options));
      else await replyScreen(ctx, "wallet", body, options);
    } catch (error) {
      console.error("Wallet error:", error);
      await replyNotice(ctx, `❌ ${userMessage(error, "Wallet is temporarily unavailable")}`);
    }
  }

  // Turns the active wallet's wNEAR back into NEAR (to the same wallet).
  pm.callbackQuery("w:unwrap", async (ctx) => {
    await ctx.answerCallbackQuery("Unwrapping…");
    try {
      const wallet = await walletService.getWallet(ctx.from.id);
      if (!wallet) return;
      const amount = await ftBalanceOf(WRAPPED_NEAR, wallet.accountId);
      if (amount <= 0n) return void await showWallet(ctx, true, "ℹ️ No wNEAR to unwrap.\n\n");
      const signer = new NearAccountSigner(await walletService.getSigningAccount(ctx.from.id, wallet.accountId));
      await signer.signAndSendTransactions(
        [{ receiverId: WRAPPED_NEAR, actions: [functionCall("near_withdraw", { amount: amount.toString() }, 10_000_000_000_000n, 1n)] }] as unknown as Parameters<NearAccountSigner["signAndSendTransactions"]>[0],
        {}
      );
      const sent = signer.sent[0];
      const note = sent?.result === "executed"
        ? `✅ <b>Unwrapped ${escapeHtml(shortNear(amount))}</b>${renderTxHashes([sent.txHash])}\n\n`
        : `❌ Unwrap did not complete.${sent ? renderTxHashes([sent.txHash]) : ""}\n\n`;
      await showWallet(ctx, true, note);
    } catch (error) {
      console.error("Unwrap error:", error);
      await replyNotice(ctx, `❌ ${userMessage(error, "Couldn't unwrap right now")}`);
    }
  });

  pm.callbackQuery("w:refresh", async (ctx) => {
    await ctx.answerCallbackQuery("Refreshing…");
    await showWallet(ctx, true);
  });

  pm.callbackQuery(/^w:use:(\d)$/, async (ctx) => {
    const wallets = await walletService.listWallets(ctx.from.id);
    const target = wallets[Number(ctx.match[1])];
    if (!target) return void await ctx.answerCallbackQuery("That wallet no longer exists");
    await walletService.switchWallet(ctx.from.id, target.accountId);
    await ctx.answerCallbackQuery(`Switched to W${Number(ctx.match[1]) + 1}`);
    await showWallet(ctx, true);
  });

  pm.callbackQuery("w:export", async (ctx) => {
    await ctx.answerCallbackQuery();
    const wallet = await walletService.getWallet(ctx.from.id);
    if (!wallet) return void await ctx.reply("👛 No wallet yet. Use /wallet to create one.");
    await ctx.editMessageText(renderExportWarning(wallet.accountId), {
      ...HTML,
      reply_markup: new InlineKeyboard().text("✅ Show my private key", "w:export:yes").row().text("❌ Cancel", "w:export:no")
    });
  });

  pm.callbackQuery("w:export:no", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled");
    await showWallet(ctx, true);
  });

  pm.callbackQuery("w:export:yes", async (ctx) => {
    if (!keyExports.take(`x:${ctx.from.id}`)) {
      return void await ctx.answerCallbackQuery("Too many key exports. Try again in an hour.");
    }
    await ctx.answerCallbackQuery();
    try {
      const { accountId, privateKey } = await walletService.exportPrivateKey(ctx.from.id);
      const sent = await ctx.reply(renderPrivateKey(accountId, privateKey), HTML);
      await scheduleDeletion(ctx.from.id, sent.chat.id, sent.message_id, KEY_MESSAGE_TTL_MS, undefined, {
        text: KEY_REMINDER_TEXT,
        remindBeforeMs: KEY_REMINDER_BEFORE_MS
      });
      console.info("Wallet key exported", { userId: ctx.from.id, accountId });
      await ctx.editMessageText("🔑 Key sent below. Save it: the message deletes itself in 24 hours.", HTML);
    } catch (error) {
      console.error("Key export failed:", error);
      await ctx.reply(`❌ ${userMessage(error, "Couldn't export the key right now")}`);
    }
  });

  pm.callbackQuery("w:new", async (ctx) => {
    try {
      await walletService.addWallet(ctx.from.id);
      await ctx.answerCallbackQuery("New wallet created");
      await showWallet(ctx, true, "✅ <b>New wallet created and selected</b>\n\n");
    } catch (error) {
      await ctx.answerCallbackQuery(userMessage(error, "Couldn't create a wallet"));
    }
  });

  pm.command("wallet", (ctx) => showWallet(ctx, false));

  pm.command("deposit", async (ctx) => {
    const wallet = await requireWallet(ctx);
    if (!wallet) return;
    await replyScreen(ctx, "deposit", 
      `📥 <b>Deposit address</b>\n\nNetwork: ${wallet.network}\n${code(wallet.accountId)}\n\nSend NEAR first: it activates the account and pays for gas. Only send assets on NEAR ${wallet.network}.`,
      HTML
    );
  });

  pm.command("balance", async (ctx) => {
    const wallet = await requireWallet(ctx);
    if (!wallet) return;
    try {
      const balance = await getNearBalance(wallet.accountId);
      await replyScreen(ctx, "balance", `💰 <b>NEAR balance</b>\n\n${renderBalance(balance)}\n\nWallet: ${code(wallet.accountId)}`, HTML);
    } catch (error) {
      console.error("Balance error:", error);
      await replyNotice(ctx, "❌ Balance is temporarily unavailable. Try again shortly.");
    }
  });

  pm.command("portfolio", showPortfolio);

  pm.command("withdraw", async (ctx) => {
    const parts = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 3) {
      return void await ctx.reply(
        "📤 Usage: /withdraw <amount|all> <token> <to-account>\n\nExamples:\n/withdraw 5 near alice.near\n/withdraw all usdt.tether-token.near alice.near"
      );
    }
    try {
      const plan = await withdrawService.prepare(ctx.from.id, parts[0]!, parts[1]!, parts[2]!);
      await replyScreen(ctx, "withdraw", renderWithdrawConfirm(plan), {
        ...HTML,
        reply_markup: new InlineKeyboard()
          .text("✅ Send", `wd:confirm:${plan.id}`)
          .text("❌ Cancel", `wd:cancel:${plan.id}`)
      });
    } catch (error) {
      console.error("Withdraw prepare error:", error);
      await replyNotice(ctx, `❌ ${userMessage(error, "Withdrawal is temporarily unavailable")}`);
    }
  });

  pm.callbackQuery(/^wd:confirm:([a-f0-9]{16})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Sending…");
    await ctx.editMessageReplyMarkup();
    try {
      const plan = { ...(await withdrawService.peek(ctx.from.id, ctx.match[1]!)) };
      const result = await withdrawService.execute(ctx.from.id, ctx.match[1]!);
      await ctx.editMessageText(renderWithdrawResult(plan, result), HTML);
      await keepScreen(ctx, "withdraw"); // the result stays in the chat
    } catch (error) {
      console.error("Withdraw error:", error);
      await ctx.editMessageText(`❌ ${userMessage(error, "Withdrawal could not be sent")}`);
    }
  });

  pm.callbackQuery(/^wd:cancel:([a-f0-9]{16})$/, async (ctx) => {
    await withdrawService.cancel(ctx.from.id, ctx.match[1]!);
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("❌ Withdrawal cancelled.");
  });

  async function prepareTrade(ctx: Context, side: "buy" | "sell") {
    const userId = ctx.from?.id;
    if (!userId) return void await ctx.reply("❌ Telegram user identity is unavailable.");

    const parts = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    // "/buy <token>" opens the token panel; "/buy <token> <amount>" quotes directly.
    if (parts.length === 1) return void await tokenPanel.open(ctx, parts[0]!);
    if (parts.length !== 2) {
      return void await ctx.reply(side === "buy"
        ? "⚡ Usage: /buy <token> [amount-near], or paste a token contract id"
        : "💰 Usage: /sell <token> [amount-token], or paste a token contract id");
    }

    try {
      const prepared = await tradingService.prepare(userId, side, parts[0]!, parts[1]!);
      const input = formatUnits(prepared.request.amountIn, prepared.request.tokenIn.decimals ?? 0);
      const output = formatUnits(prepared.quote.expectedOut, prepared.quote.tokenOut.decimals ?? 0);
      const minimum = formatUnits(prepared.quote.minAmountOut, prepared.quote.tokenOut.decimals ?? 0);
      const symbolIn = escapeHtml(prepared.request.tokenIn.symbol ?? prepared.request.tokenIn.address);
      const symbolOut = escapeHtml(prepared.request.tokenOut.symbol ?? prepared.request.tokenOut.address);
      const seconds = Math.max(0, Math.round((prepared.expiresAt - Date.now()) / 1000));

      await ctx.reply(
        "🔎 <b>Confirm trade</b>\n\n" +
        `Side: ${side.toUpperCase()}\n` +
        `You spend: ${prepared.fee ? formatUnits(prepared.total, prepared.request.tokenIn.decimals ?? 0) : input} ${symbolIn}\n` +
        (prepared.fee
          ? `Fee: ${formatUnits(prepared.fee.amount, prepared.request.tokenIn.decimals ?? 0)} ${symbolIn}${prepared.fee.capped ? " (capped)" : ""}\nSwapping: ${input} ${symbolIn}\n`
          : "") +
        `Expected: ${output} ${symbolOut}\n` +
        `Minimum: ${minimum} ${symbolOut}\n` +
        `Slippage: ${prepared.request.slippageBps / 100}%\n` +
        `Router: ${escapeHtml(describeRoute(prepared.quote.direct ? undefined : prepared.quote.raw?.route, prepared.quote.raw?.alternatives?.length ?? 0))}\n\n` +
        (valueLossWarning(prepared.valueLoss) ? `${escapeHtml(valueLossWarning(prepared.valueLoss)!)}\n\n` : "") +
        (prepared.unlisted
          ? `⚠️ <b>Unlisted token.</b> ${code(side === "buy" ? prepared.request.tokenOut.address : prepared.request.tokenIn.address)} is not on RHEA's token list. Verify the contract; anyone can deploy a token with any symbol.\n\n`
          : "") +
        `Quote expires in ${seconds}s.`,
        {
          ...HTML,
          reply_markup: new InlineKeyboard()
            .text("✅ Confirm", `trade:confirm:${prepared.id}`)
            .text("❌ Cancel", `trade:cancel:${prepared.id}`)
        }
      );
    } catch (error) {
      console.error("Trade quote error:", error);
      await replyNotice(ctx, `❌ ${userMessage(error, "Unable to create a quote right now")}`);
    }
  }

  pm.command("buy", async (ctx) => { await prepareTrade(ctx, "buy"); });
  pm.command("sell", async (ctx) => { await prepareTrade(ctx, "sell"); });

  pm.callbackQuery(/^trade:confirm:([a-f0-9]{16})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Executing trade…");
    await ctx.editMessageReplyMarkup();
    try {
      const result = await tradingService.execute(ctx.from.id, ctx.match[1]!);
      await ctx.editMessageText(renderExecution(result), HTML);
    } catch (error) {
      console.error("Trade execution error:", error);
      await ctx.editMessageText(`❌ ${userMessage(error, "Trade could not be executed")}`);
    }
  });

  pm.callbackQuery(/^trade:cancel:([a-f0-9]{16})$/, async (ctx) => {
    await tradingService.cancel(ctx.from.id, ctx.match[1]!);
    await ctx.answerCallbackQuery("Trade cancelled");
    await ctx.editMessageText("❌ Trade cancelled.");
  });

  pm.callbackQuery(/^trade:(buy|sell)$/, async (ctx) => {
    const side = ctx.match[1];
    await ctx.answerCallbackQuery();
    await ctx.reply(side === "buy"
      ? "⚡ Buy\n\nPaste a token contract id (e.g. token.near) to open its trading panel, or send /buy <token> <amount-near>."
      : "💰 Sell\n\nPaste a token contract id to open its trading panel, or send /sell <token> <amount-token>.");
  });
  pm.callbackQuery("portfolio", async (ctx) => { await ctx.answerCallbackQuery(); await showPortfolio(ctx); });
  pm.command("new", async (ctx) => { await showLaunchFeed(ctx, false); });
  pm.callbackQuery("discover", async (ctx) => { await ctx.answerCallbackQuery(); await showLaunchFeed(ctx, false); });
  pm.callbackQuery("nl:feed", async (ctx) => { await ctx.answerCallbackQuery("Refreshing…"); await showLaunchFeed(ctx, true); });
  pm.callbackQuery(/^nl:(\d{1,12})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const launch = await fetchLaunch(Number(ctx.match[1]));
      if (!launch) return void await replyNotice(ctx, "That launch isn't tradable yet.");
      await tokenPanel.open(ctx, launch.token);
    } catch (error) {
      console.error("NEARly launch error:", error);
      await replyNotice(ctx, "❌ Couldn't load that launch right now.");
    }
  });
  pm.callbackQuery("wallet", async (ctx) => { await ctx.answerCallbackQuery(); await showWallet(ctx, false); });
  async function showSettings(ctx: Context, edit: boolean) {
    const { text, keyboard } = renderSettings(await settingsService.slippage(ctx.from!.id));
    const options = { ...HTML, reply_markup: keyboard };
    if (edit) await ctx.editMessageText(text, options).catch(() => {});
    else await replyScreen(ctx, "settings", text, options);
  }
  pm.command("settings", (ctx) => showSettings(ctx, false));
  pm.callbackQuery("settings", async (ctx) => { await ctx.answerCallbackQuery(); await showSettings(ctx, false); });
  pm.callbackQuery("st:noop", (ctx) => ctx.answerCallbackQuery());
  pm.callbackQuery(/^st:(buy|sell):(\d+(?:\.\d+)?)$/, async (ctx) => {
    try {
      const value = await settingsService.setSlippage(ctx.from.id, ctx.match[1] as "buy" | "sell", Number(ctx.match[2]));
      await ctx.answerCallbackQuery(`${ctx.match[1] === "buy" ? "Buy" : "Sell"} slippage set to ${value}%`);
      await showSettings(ctx, true);
    } catch (error) {
      await ctx.answerCallbackQuery(userMessage(error, "Couldn't save that setting"));
    }
  });

  // Registered last: its text handler falls through to nothing else.
  tokenPanel.register(bot);
}
