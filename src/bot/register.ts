import { InlineKeyboard, type Bot, type Context } from "grammy";
import { mainMenu } from "./menu.js";
import { WalletService } from "../wallet/service.js";
import { getNearBalance, type NearBalance } from "../near/account.js";
import { formatUnits } from "@rhea-finance/cross-chain-aggregation-dex";
import { TradingService } from "../trading/service.js";
import { PortfolioService, type PortfolioAsset } from "../portfolio/service.js";
import type { ExecutionResult } from "../trading/service.js";
import { config } from "../config.js";
import { userMessage } from "../errors.js";
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

/** HTML message for a trade outcome. */
export function renderExecution(result: ExecutionResult): string {
  const links = result.txHashes
    .map((hash) => `<a href="${explorerTx(hash)}">${escapeHtml(hash.slice(0, 8))}…</a>`)
    .join("\n");
  const txs = links ? `\n\n${links}` : "";
  const reason = result.reason ? escapeHtml(result.reason) : undefined;
  switch (result.status) {
    case "filled":
      return `✅ <b>Trade filled</b>${txs}`;
    case "submitted":
      return `✅ <b>Trade executed on chain.</b> Fill could not be verified yet; check /portfolio.${txs}`;
    case "reverted":
      return `↩️ <b>Trade did not fill.</b> ${reason ?? "The swap failed on chain"}.\nYour tokens were not exchanged; only gas (and any storage deposit) was spent.${result.feeRefundDue ? "\nThe protocol fee taken on this swap has been recorded for refund." : ""}${txs}`;
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
  const links = result.txHashes.map((hash) => `<a href="${explorerTx(hash)}">${escapeHtml(hash.slice(0, 8))}…</a>`).join("\n");
  const txs = links ? `\n\n${links}` : "";
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
      await ctx.reply(text, options);
    }
  } catch (error) {
    console.error("NEARly feed error:", error);
    await ctx.reply("❌ New launches are temporarily unavailable. Try again shortly.");
  }
}

async function requireWallet(ctx: Context) {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    await ctx.reply("❌ Telegram user identity is unavailable.");
    return undefined;
  }
  const wallet = await walletService.getWallet(telegramUserId);
  if (!wallet) {
    await ctx.reply("👛 No wallet yet. Use /wallet to create one.");
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
    await ctx.reply(renderPortfolio(near, assets), HTML);
  } catch (error) {
    console.error("Portfolio error:", error);
    await ctx.reply("❌ Portfolio is temporarily unavailable. Try again shortly.");
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

  pm.command("start", async (ctx) => {
    await ctx.reply("⚡ Neyro\n\nNEAR trading terminal.\n\nChoose an action:", { reply_markup: mainMenu() });
  });

  async function showWallet(ctx: Context) {
    const telegramUserId = ctx.from!.id;
    try {
      const existing = await walletService.getWallet(telegramUserId);
      if (existing) {
        const balance = await getNearBalance(existing.accountId);
        await ctx.reply(
          `👛 <b>Your Neyro wallet</b>\n\nNetwork: ${existing.network}\nAccount: ${code(existing.accountId)}\nBalance: ${renderBalance(balance)}\n\nUse /deposit to fund it and /withdraw to send funds out.`,
          HTML
        );
        return;
      }
      const wallet = await walletService.createWallet(telegramUserId);
      await ctx.reply(
        `✅ <b>Wallet created</b>\n\nNetwork: ${wallet.network}\nAccount: ${code(wallet.accountId)}\n\nUse /deposit to fund this wallet.\n\n⚠️ This wallet is custodial. Do not deposit meaningful funds until recovery and operational safeguards are fully deployed.`,
        HTML
      );
    } catch (error) {
      console.error("Wallet error:", error);
      await ctx.reply(`❌ ${userMessage(error, "Wallet is temporarily unavailable")}`);
    }
  }
  pm.command("wallet", showWallet);

  pm.command("deposit", async (ctx) => {
    const wallet = await requireWallet(ctx);
    if (!wallet) return;
    await ctx.reply(
      `📥 <b>Deposit address</b>\n\nNetwork: ${wallet.network}\n${code(wallet.accountId)}\n\nSend NEAR first: it activates the account and pays for gas. Only send assets on NEAR ${wallet.network}.`,
      HTML
    );
  });

  pm.command("balance", async (ctx) => {
    const wallet = await requireWallet(ctx);
    if (!wallet) return;
    try {
      const balance = await getNearBalance(wallet.accountId);
      await ctx.reply(`💰 <b>NEAR balance</b>\n\n${renderBalance(balance)}\n\nWallet: ${code(wallet.accountId)}`, HTML);
    } catch (error) {
      console.error("Balance error:", error);
      await ctx.reply("❌ Balance is temporarily unavailable. Try again shortly.");
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
      await ctx.reply(renderWithdrawConfirm(plan), {
        ...HTML,
        reply_markup: new InlineKeyboard()
          .text("✅ Send", `wd:confirm:${plan.id}`)
          .text("❌ Cancel", `wd:cancel:${plan.id}`)
      });
    } catch (error) {
      console.error("Withdraw prepare error:", error);
      await ctx.reply(`❌ ${userMessage(error, "Withdrawal is temporarily unavailable")}`);
    }
  });

  pm.callbackQuery(/^wd:confirm:([a-f0-9]{16})$/, async (ctx) => {
    await ctx.answerCallbackQuery("Sending…");
    await ctx.editMessageReplyMarkup();
    try {
      const plan = { ...(await withdrawService.peek(ctx.from.id, ctx.match[1]!)) };
      const result = await withdrawService.execute(ctx.from.id, ctx.match[1]!);
      await ctx.editMessageText(renderWithdrawResult(plan, result), HTML);
    } catch (error) {
      console.error("Withdraw error:", error);
      await ctx.editMessageText(`❌ ${userMessage(error, "Withdrawal could not be sent")}`);
    }
  });

  pm.callbackQuery(/^wd:cancel:([a-f0-9]{16})$/, async (ctx) => {
    withdrawService.cancel(ctx.from.id, ctx.match[1]!);
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
        `Router: ${escapeHtml(describeRoute(prepared.quote.raw.route, prepared.quote.raw.alternatives?.length ?? 0))}\n\n` +
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
      await ctx.reply(`❌ ${userMessage(error, "Unable to create a quote right now")}`);
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
      if (!launch) return void await ctx.reply("That launch isn't tradable yet.");
      await tokenPanel.open(ctx, launch.token);
    } catch (error) {
      console.error("NEARly launch error:", error);
      await ctx.reply("❌ Couldn't load that launch right now.");
    }
  });
  pm.callbackQuery("wallet", async (ctx) => { await ctx.answerCallbackQuery(); await showWallet(ctx); });
  async function showSettings(ctx: Context, edit: boolean) {
    const { text, keyboard } = renderSettings(await settingsService.slippage(ctx.from!.id));
    const options = { ...HTML, reply_markup: keyboard };
    if (edit) await ctx.editMessageText(text, options).catch(() => {});
    else await ctx.reply(text, options);
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
