# Freelancer.com Order Monitor

Cloudflare Worker (TypeScript) that scans new Freelancer.com projects every minute across 12 niches, filters duplicates and junk, scores promising orders with an LLM (Kimi), and sends Telegram cards with a ready-made bid draft. A human reviews each card and submits the bid manually — **the bot never bids on its own**. This module is for Freelancer; the architecture is designed to admit other platforms (Upwork etc.) later — platform-specific parsing/selection stays isolated from the shared pipeline.

## How it works

Minute-cron pipeline, 4 layers:

```
[1] Parser          fetchAllNiches → fresh orders from the Freelancer API
      ↓
[2] Dedup/filters   KV seen:* + static rules (bids count, language,
                    fulltime-only, deadline) — no budget/rate thresholds,
                    price fitness is decided by the LLM only
      ↓
[3] LLM scoring     scoreOrder → verdict BID / PASS (Kimi, JSON-schema,
                    retries, validation)
      ↓
[4] Telegram        order card + bid draft (no rate limit; error alerts
                    throttled to 1/hour)
```

Niches rotate: `pickNiches` takes 4 niches per tick, a full pass takes 3 minutes.

## Project structure

```
src/
  index.ts     — entry point: cron tick, /test/* endpoints
  config.ts    — env → typed config
  types.ts     — Order, ScoreResult, Env, Niche
  niches.ts    — 12 niches with search queries
  parser.ts    — Freelancer API → Order[]
  service.ts   — KV dedup, static filters, niche rotation
  kimi.ts      — scoring via Kimi API (JSON-schema, retries, validation)
  prompts.ts   — scoring prompts and bid text templates
  telegram.ts  — cards, alerts
rules/         — selection rules and response skill; their file content is injected into the LLM prompts at build time (scripts/gen-rules.mjs)
```

## Configuration

Non-secret tunables live in `wrangler.toml` `[vars]` (model name, API bases, weekly limit, card rate limits). Secrets are set only via `wrangler secret` / dashboard and never appear in the repo:

```
KIMI_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
ADMIN_TOKEN
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
npm run deploy
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
POST /test/set-webhook   — register the Telegram webhook (required once for the "applied" button)
```

Run the tests and only then enable the `[triggers] crons` schedule in `wrangler.toml`.

## Red line

No auto-bidding anywhere in the codebase. The worker only monitors and sends cards; a human submits every bid by hand.
