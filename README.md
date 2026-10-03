# Freelancer.com Order Monitor

Cloudflare Worker (TypeScript) that watches Freelancer.com saved-search alerts, dedups, enriches owner info, LLM-scores new orders (Kimi), and **places bids automatically** through the official Freelancer API. Cards and operator commands go through Telegram. Three modes gate the bidding: `test` (default — everything runs, bid is not sent), `live` (real bids), `off` (tick exits immediately). This module is for Freelancer; the architecture is designed to admit other platforms (Upwork etc.) later — platform-specific parsing/selection stays isolated from the shared pipeline.

## How it works

Minute-cron pipeline:

```
[1] Alerts          saved-search alerts → project ids → fetchProjectsByIds
      ↓
[2] Dedup/gate      D1 seen (30d retention); static gate: bids > 5 rejected
      ↓
[3] Enrich          fetchOwnerInfo → order.owner (goes into scoring JSON)
      ↓
[4] Bids gate       D1 bid_ledger balance; 0 → reject rej:no-bids,
                    null → daily "set /setbids N" alert
      ↓
[5] LLM scoring     scoreOrder → verdict BID / PASS (value_score + ai_hours,
                    Kimi, JSON-schema, retries, validation)
      ↓
[6] Bid + card      placeBid (official API, OAuth; pre-flight bids ≤ 10);
                    Telegram card only for BID: [TEST] / ✅ placed / ⚠️ failed
```

## Telegram commands (operator chat only)

```
/mode test|live|off  — switch bid mode
/status              — mode, bids balance, seen stats for 24h
/setbids N           — record actual bids balance into the D1 ledger
```

## Project structure

```
src/
  index.ts        — entry point: cron tick, /test/* endpoints, Telegram webhook
  config.ts       — env → typed config
  types.ts        — Order, ScoreResult, OwnerInfo, Env
  parser.ts       — normalizeProject (Freelancer project → Order)
  enrich.ts       — fetchProjectsByIds, fetchOwnerInfo
  service.ts      — D1 dedup, alert gate, seen stats
  bids-balance.ts — D1 bid ledger (balance/regen/setBalance/recordBidSpent)
  bidder.ts       — placeBid via official Freelancer API (OAuth)
  mode.ts         — getMode/setMode (KV, default test)
  kimi.ts         — scoring via Kimi API (JSON-schema, retries, validation)
  prompts.ts      — scoring prompts and bid text templates
  telegram.ts     — BID cards, alerts
rules/            — selection rules and response skill; their file content is injected into the LLM prompts at build time (scripts/gen-rules.mjs)
```

## Configuration

Non-secret tunables live in `wrangler.toml` `[vars]` (model name, API bases, weekly limit, `TARGET_HOURLY`, `BID_MIN_SCORE`). Secrets are set only via `wrangler secret` / dashboard and never appear in the repo:

```
KIMI_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
ADMIN_TOKEN
FL_OAUTH_TOKEN     — required for live bidding
FL_USER_ID         — bidder id, required for live bidding
```

## Deployment

Every push to `main` deploys automatically via GitHub Actions (`.github/workflows/deploy.yml`).

Manual path:

```bash
npm install
wrangler kv namespace create ORDERS_KV   # put the id into wrangler.toml
wrangler secret put KIMI_API_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put ADMIN_TOKEN
wrangler secret put FL_OAUTH_TOKEN
npm run deploy
wrangler d1 migrations apply freelancer-monitor --remote
```

Required GitHub repository secrets for CI: `CLOUDFLARE_API_TOKEN` (Workers edit permission).

## Testing

All test endpoints require the `X-Admin-Token` header:

```
curl -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker>/test/kimi-models
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker>/test/score
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker>/test/tick
```

```
POST /test/set-webhook   — register the Telegram webhook (required once for commands)
```

Run the tests and only then enable the `[triggers] crons` schedule in `wrangler.toml`. Keep the mode at `test` until the whole chain is verified, then `/mode live` from the operator chat.
