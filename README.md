# Freelancer.com Order Monitor

Cloudflare Worker (TypeScript) that watches new Freelancer.com orders, enriches them
with client data, LLM-scores every fresh order (Kimi), and **places bids automatically**
through the Freelancer web API. Cards and operator commands go through Telegram.
Three modes gate the bidding: `test` (default — everything runs, bid is not sent),
`live` (real bids), `off` (channels tick but do nothing).

## How it works

The pipeline lives in Durable Objects (actor model). Each channel has its own
`ChannelRunner` instance running a 10 s alarm chain; the minute cron is only a
watchdog that re-arms broken alarm chains after deploys/errors.

Intake: official public `projects/active` polling for the shared feed (11 skills,
fixed+hourly, en, newest first, submitdate cursor) plus per-profile search channels
(`projects/search/active` per `SearchSpec` in `channels.ts`).

```
[1] Intake            fetchActiveOrders / fetchSearchOrders (per channel, cursor in
                      the ChannelRunner storage) → normalizeProject
        ↓
[2] Dedup             OrdersBank.checkAndMark — D1 seen (30d retention, INSERT OR
                      IGNORE; the DO is the single owner and race arbiter)
        ↓
[3] Enrich + gates    fetchProjectClient (closed users/0.1/users endpoint) →
                      order.client; static pre-bid gates (recruiter, KYC,
                      crypto-skill, competition ≤ PHASE_MAX_BIDS, phase-0 budget
                      ceilings) via preBidRejectReason — reject cards in test mode
        ↓
[4] Artifacts         fetchOrderArtifacts — text attachments + pages linked from
                      the description (go into the scoring JSON)
        ↓
[5] LLM scoring       scoreOrder → verdict BID / PASS (profile pick, hours est.,
                      bid amount with floor/cap, upgrade plan, 2–4 milestone plan
                      for fixed with the first milestone at 30%; JSON-schema,
                      retries, 429-safe concurrency 3 per channel)
        ↓
[6] Budget            BidBudget.reserve() — reservation so the last bid is never
                      spent twice between channels / inside a batch
        ↓
[7] Bid text          generateBidText (portfolio context, rules from rules/*.md)
        ↓
[8] Bid + card        placeBid via web API (freelancer-auth-v2; OAuth token or
                      Develop API key as fallback); milestone requests go out
                      with the bid; sealed bought via cart automatically;
                      Telegram card for BID, PASS/reject cards in test mode
        ↓
[9] Milestones        checkMilestones on the feed channel (throttled to 1/5 min):
                      awarded bids → alert; milestone requests polled for
                      active/funded/released → Telegram alerts
```

Bids gate before any fetching: when the bids balance is 0 the channel goes idle
(no API polling, no LLM) until a bid is restored; the cursor does not move, so the
window catches up on resume. When the balance is unreadable the pipeline runs
without raising the bar and alerts once a day.

## Telegram commands (operator chat only)

```
/mode test|live|off   — switch bid mode (no argument → inline keyboard)
/schedule 9 22        — bidding window (hours, start < end); /schedule on|off,
                        no argument → interactive keyboard with presets
/status               — mode, schedule, bids balance, seen stats for 24h
```

## Project structure

```
src/
  index.ts        — entry point: DO class registration/exports, cron watchdog
                    (1/min), /test/* + /admin/* endpoints, Telegram webhook
  durable.ts      — ChannelRunner (10 s tick per channel), OrdersBank (seen dedup,
                    daily cleanup), BidBudget (bid reservations), runOrderPipeline
  channels.ts     — channel registry (feed shared channel, General/Android search
                    channels, SearchSpec, enabled via CHANNEL_ANDROID_ENABLED)
  profiles.ts     — profile name → numeric id resolution (fetchProfileMap)
  sources/
    freelancer-active.ts — feed intake (projects/active, cursor, throttling)
    freelancer-search.ts — search-channel intake per SearchSpec
  parser.ts       — normalizeProject (Freelancer project → Order)
  enrich.ts       — fetchProjectClient (users/0.1/users), fetchPortfolio (KV cache),
                    fetchOrderArtifacts (attachments + linked pages)
  service.ts      — preBidRejectReason (static gates), seenStats24h
  bids-balance.ts — getBidLimit balance (web auth, KV override), D1 bid_ledger
  web-auth.ts     — freelancer-auth-v2 web session resolution (KV override)
  bidder.ts       — placeBid via web API, milestone requests, sealed via cart
  milestones.ts   — awarded-bid detection, milestone status polling (1/5 min)
  kimi.ts         — scoring + bid text via Kimi API (JSON-schema, retries)
  prompts.ts      — prompt assembly (rules injected from rules/*.md at build time)
  payments.ts     — payment screens (sealed purchase via cart)
  order-context.ts— order message context (cards linked to orders)
  orderRate       — currency rate recovered from budget (in telegram.ts)
  mode.ts         — getMode/setMode (KV, default test)
  schedule.ts     — bidding window (parse/format/apply, Europe/Minsk)
  logger.ts       — ring buffer of recent logs (flushed to KV)
  telegram.ts     — BID/PASS/reject cards, alerts, orderRate
  config.ts       — env → typed config
  types.ts        — Order, ScoreResult, ProjectClientInfo, Env
  generated/      — rules.ts (built by scripts/gen-rules.mjs from rules/*.md)
scripts/
  gen-rules.mjs   — rules/*.md → src/generated/rules.ts
  acceptance.ts   — offline acceptance suite (pure logic, mocked fetch/KV)
rules/            — selection rules + bid skill (single source of truth for LLM)
migrations/       — D1 schema (seen, bid_ledger)
```

## Configuration

Non-secret tunables live in `wrangler.toml` `[vars]`:

```
KIMI_API_BASE            — Kimi endpoint
KIMI_MODEL               — model name
FREELANCER_API_BASE      — official API base
DEFAULT_WEEKLY_LIMIT     — weekly hours cap for hourly bids
TARGET_HOURLY            — target hourly rate (USD)
BID_MIN_SCORE            — minimum value_score to bid
PHASE_MAX_BIDS           — phase-0 competition ceiling (reject above)
PHASE_BUDGET_FIXED_USD   — phase-0 fixed budget ceiling
PHASE_BUDGET_HOURLY_USD  — phase-0 hourly rate ceiling
MAX_ORDER_AGE_MIN        — skip orders older than N minutes at intake (default 20; 0 = off)
```

Secrets — only via `wrangler secret` / dashboard, never in the repo:

```
KIMI_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
ADMIN_TOKEN
FL_USER_ID         — bidder id
FL_AUTH_HASH       — web auth (freelancer-auth-v2) for bidding/balance/purchases
FL_OAUTH_TOKEN     — optional account OAuth token (preferred when present)
FL_API_KEY         — optional Develop API key (Authorization: Bearer), fallback
```

Optional `.dev.vars`-only flags: `DEV_MARKER=1` (prefix Telegram messages with
`[DEV]`), `CHANNEL_ANDROID_ENABLED=1` (enable the Android channel).

## Deployment

Every push to `main` deploys automatically via GitHub Actions
(`.github/workflows/deploy.yml`). Manual path: `npm run deploy` (runs typecheck
+ gen-rules via pre-hooks).

## Testing

Offline acceptance (no network, no secrets):

```bash
npm run acceptance   # pure-logic suite: scoring math, currency, sanitizer,
                     # client/portfolio parsing, cards, upgrade cap, schedule
```

Admin endpoints (require the `X-Admin-Token` header; the Telegram webhook is at
`/tg-webhook/<ADMIN_TOKEN>`):

```
GET  /test/kimi-models      — list Kimi models (proxied)
POST /test/score            — score a given order JSON (live feed order if body empty)
POST /test/tick             — wake all active channel runners (ensure alarm)
GET  /test/channels         — per-channel runner status (last fetch, errors, in-flight)
GET  /test/profiles         — resolved profile map
POST /test/set-webhook      — register the Telegram webhook (required once)
GET  /test/logs             — recent log ring
GET  /test/bids-balance     — current bids balance
POST /test/milestones       — milestone scan; dry-run by default, {"dryRun": false} acts
GET|POST /admin/fl-auth     — get/set the web-auth KV override ({userId, hash})
```
