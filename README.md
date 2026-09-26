# Neyro

NEAR-native Telegram trading terminal.

## Status

Early foundation. The first milestone is NEAR spot trading through RHEA, followed by NEARly token discovery.

## Architecture

Telegram -> Bot/Application -> Trading Engine -> NEAR/RHEA

### Planned modules

- Telegram UX and command handlers
- NEAR wallet/account management
- RHEA quote and swap adapter
- NEARly token discovery/indexing
- Portfolio and transaction tracking
- Risk controls and encrypted signer storage

## Protocol fee

Neyro charges 1% of each trade, capped at $60, inside the swap transaction.
Fees go to the team wallet `widekingdom6862.near`, set with
`TREASURY_ACCOUNT_ID` (see `.env.example`). Fees are off when it is unset.

## Deploying to Cloudflare Workers

The Worker (`src/worker.ts`, configured in `wrangler.jsonc`) receives Telegram
updates by webhook, and a cron trigger settles unresolved trades every minute.

1. Run `docs/schema.sql` on the Postgres database (Neon works well).
2. In the Worker's Settings → Variables and Secrets, set:
   - `TELEGRAM_BOT_TOKEN`, `NEYRO_MASTER_KEY`, `DATABASE_URL` (secrets)
   - Network, RPCs and the fee wallet are fixed in `wrangler.jsonc` (mainnet).
   - `TELEGRAM_WEBHOOK_SECRET` and `SETUP_SECRET`: any long random strings
   - `FASTNEAR_API_KEY` (recommended): keyless FastNEAR access is rate-limited
     per IP, and Workers share IPs. rpc.mainnet.near.org is deprecated for
     backend use, so it is only a last-resort fallback.
3. Deploy: build command `npm run build`, deploy command `npx wrangler deploy`.
4. Open `https://<worker>.workers.dev/setup-webhook?secret=<SETUP_SECRET>` once.
   This points Telegram at the Worker and registers the command menu.
5. Check `https://<worker>.workers.dev/health`.

`DATABASE_URL` is required on Workers: each update may run in a different
isolate, so wallets, quotes, panels and pending withdrawals live in Postgres.
For production, enable the optional Queue in `wrangler.jsonc` so long trades
are never cut off.

Neyro runs on NEAR mainnet: it is the default, and the Worker refuses any
other network. Run the bot locally with `npm run dev` (long polling via
`src/index.ts`).

## Security

Never commit Telegram bot tokens, RHEA API tokens, seed phrases, private keys, or production credentials.

## Development

Node.js + TypeScript.

See `docs/PLAN.md` for the product and implementation roadmap.
