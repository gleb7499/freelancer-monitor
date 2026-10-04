# Freelancer.com Order Monitor

Cloudflare Worker (TypeScript) that watches new Freelancer.com orders, enriches them
with client data, LLM-scores every fresh order (Kimi), and **places bids automatically**
through the official Freelancer API. Cards and operator commands go through Telegram.
Three modes gate the bidding: `test` (default — everything runs, bid is not sent),
`live` (real bids), `off` (tick exits immediately).

## How it works

Pipeline ticking every 10 s (Durable Object alarms; minute cron is a watchdog).
Intake: official public `projects/active` polling (11 skills, fixed+hourly, en,
newest first, submitdate cursor):

```
[1] Intake            projects/active → normalizeProject
        ↓
[2] Dedup/gate        D1 seen (30d retention); static gate: bids > 10 rejected
        ↓
[3] Enrich            projects/seo → order.client (verification, employer rating,
                      open orders) → goes into scoring JSON
        ↓
[4] Bids gate         getBidLimit balance (web auth, KV override); 0 → idle
        ↓
[5] LLM scoring       scoreOrder → verdict BID / PASS (value_score in USD recalc,
                      native-currency bid snapped to a round grid, floor/cap,
                      code-enforced thresholds, JSON-schema, retries)
        ↓
[6] Bid text          generateBidText (portfolio context, plain-text ASCII only,
                      sanitizer post-pass)
        ↓
[7] Bid + card        placeBid (official API, OAuth or Develop API key;
                      pre-flight bids ≤ 10; milestone 30% for large/unverified);
                      Telegram card for BID; compact card for PASS in test mode
        ↓
[8] Milestones        every tick (throttled): awarded bids → kickoff milestone
                      request (30%, fixed ≥ ~$100), Telegram notification
```

## Telegram commands (operator chat only)

```
/mode test|live|off  — switch bid mode
/status              — mode, bids balance, seen stats for 24h
```

## Project structure

```
src/
  index.ts        — entry point: TickScheduler DO (10 s alarm loop), cron watchdog,
                    /test/* admin endpoints, Telegram webhook
  config.ts       — env → typed config
  types.ts        — Order, ScoreResult, ProjectClientInfo, PortfolioInfo, Env
  parser.ts       — normalizeProject (Freelancer project → Order)
  enrich.ts       — fetchProjectsByIds, fetchProjectClient, fetchPortfolio (KV cache)
  service.ts      — D1 dedup, alert gate, seen stats
  bids-balance.ts — bids balance via getBidLimit.php (read-only), D1 ledger fallback
  bidder.ts       — placeBid via official Freelancer API
  milestones.ts   — awarded-bid detection, kickoff milestone requests (KV dedup)
  mode.ts         — getMode/setMode (KV, default test)
  kimi.ts         — scoring + bid text via Kimi API (validation, sanitizer)
  prompts.ts      — scoring prompts (rules injected from rules/*.md at build time)
  telegram.ts     — BID/PASS/reject cards, alerts
scripts/
  gen-rules.mjs   — rules/*.md → src/generated/rules.ts
  acceptance.ts   — offline acceptance suite (pure logic, mocked fetch/KV)
rules/            — selection rules + bid skill (single source of truth for LLM)
```

## Configuration

Non-secret tunables live in `wrangler.toml` `[vars]` (`TARGET_HOURLY`,
`BID_MIN_SCORE`, weekly limit, model, API bases). Secrets — only via
`wrangler secret` / dashboard, never in the repo:

```
KIMI_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
ADMIN_TOKEN
FL_USER_ID         — bidder id
FL_AUTH_HASH       — web auth (freelancer-auth-v2) for getBidLimit
FL_API_KEY         — Develop API key (Authorization: Bearer): bidding fallback,
                     milestones, portfolio
FL_OAUTH_TOKEN     — optional account OAuth token (preferred when present)
```

## Deployment

Every push to `main` deploys automatically via GitHub Actions
(`.github/workflows/deploy.yml`). Manual path: `npm run deploy` (runs typecheck
+ gen-rules via pre-hooks).

## Testing

Offline acceptance (no network, no secrets):

```bash
npm run acceptance   # pure-logic suite: scoring math, currency, sanitizer,
                     # client/portfolio parsing, cards, upgrade cap
```

Admin endpoints (require the `X-Admin-Token` header):

```
GET  /test/kimi-models
POST /test/score       — score a given order JSON (live orders if body empty)
POST /test/tick        — run one tick manually
POST /test/milestones  — milestone scan; dry-run by default, {"dryRun": false} acts
GET  /test/logs        — recent log ring
GET  /test/bids-balance
POST /test/set-webhook — register the Telegram webhook (required once)
```
