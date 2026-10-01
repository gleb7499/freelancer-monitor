# AGENT.md — guidance for coding agents

## What this is

Cloudflare Worker (TypeScript) that monitors Freelancer.com for new orders in 12 niches, filters and LLM-scores them (Kimi API), and sends Telegram cards with a bid draft. Cron tick: every minute. KV namespace `ORDERS_KV` is used for dedup state.

## Hard rules (never violate)

1. **No auto-bidding.** The worker only monitors and sends cards. A human submits every bid manually. Do not add any code that posts bids or applies to projects.
2. **Secrets never in the repo.** `KIMI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_TOKEN` exist only as Worker secrets / `.dev.vars` (gitignored). Never commit them, never log them.
3. **Never commit `.dev.vars`.** Example file: `.dev.vars.example`.
4. Repo is public. Treat anything added to git as published.

## Commands

```bash
npm install          # deps
npm run typecheck    # tsc --noEmit — must pass before any commit
npm run deploy       # wrangler deploy (OAuth login locally)
wrangler dev         # local dev server; reads .dev.vars for secrets
wrangler types       # regenerate Env types after config/binding changes
```

CI (GitHub Actions) deploys on every push to `main`: `npm ci` → `npm run typecheck` → `wrangler deploy` via `cloudflare/wrangler-action`. Requires repo secret `CLOUDFLARE_API_TOKEN`.

## Architecture

Pipeline per cron tick (4 layers), all in `src/`:

- `index.ts` — entry: scheduled tick + admin test endpoints under `/test/*`
- `parser.ts` — Freelancer API → `Order[]` (`fetchAllNiches`); бюджеты пересчитываются в USD через `currency.exchange_rate`, оригинальные суммы и код валюты сохраняются для карточки
- `service.ts` — KV dedup (`seen:*`), static filters (bids, language, fulltime, deadline), niche rotation (`pickNiches`, 4 niches/tick, full pass 3 min). Бюджет/ставка НЕ фильтруются — ценовая пригодность решает только LLM
- `kimi.ts` — LLM scoring, JSON-schema output, retries, validation
- `prompts.ts` — scoring prompts; operator-facing fields (`reason`, `red_flags`, `check_manually`, `deadline_caveat`, `summary_ru`) are written in Russian by design
- `telegram.ts` — cards, 5 cards/hour limit, overflow digest, alerts throttled to 1/hour
- `config.ts` / `types.ts` / `niches.ts` — typed env config, shared types, 12 niche definitions

Non-secret tunables live in `wrangler.toml` `[vars]` (model, API bases, thresholds, limits). Change them there, not in code.

## rules/ — single source of truth for selection logic

`rules/` holds the original selection rules, niche list, and response skill. They are the spec that `niches.ts`, `service.ts` filters, and `prompts.ts` encode. When changing selection behavior, update the code **and** check whether `rules/` needs to reflect the new logic.

## Post-scoring rules (deterministic, LLM does not decide these)

- **Weekly limit (hourly):** final `weekly_limit_hours = min(LLM value or DEFAULT_WEEKLY_LIMIT, DEFAULT_WEEKLY_LIMIT, 40)` (`clampWeeklyLimit`). LLM may lower it for a tight deadline, never raise it.
- **Fee/net:** fixed — 10% with $5 minimum; hourly — flat 10%, no minimum.
- **No budget floors.** Budget/rate thresholds were deliberately removed: static filters and post-scoring validation never reject by price (no `MIN_BUDGET_USD`/`MIN_FIXED_USD`/`MIN_HOURLY_USD`). Cheap orders (incl. low INR budgets) reach the LLM, which decides price fitness in the verdict.

Note: platform-specific selection rules live in `rules/freelancer-*.md`. More platforms (Upwork etc.) are planned — each platform will have slightly different selection rules, so keep platform-specific logic separated from the common pipeline (parser per platform, shared dedup/scoring/card layers).

## Response tracking (Telegram inline button)

BID cards carry an inline button «Откликнулся ✅» (`callback_data: "applied:{id}"`). Telegram callbacks arrive at the webhook path `/tg-webhook/{ADMIN_TOKEN}` (authorized by the token in the URL, not a header). Pressing writes `applied:{id}` to KV and removes the pending record.

KV keys:

- `bidcard:{id}` — `{sent_at, title, project_id}`, written when a BID card is sent (TTL 24h). Each tick, `pingUnappliedBids` pings orders older than 25 minutes without `applied:{id}` with one short message «Не откликнулся: {title}», then deletes the key (one ping only).
- `applied:{id}` — confirmation timestamp (TTL 24h).

The webhook must be registered once after deploy (or after the worker URL changes):

```
POST /test/set-webhook   (header X-Admin-Token) — calls Telegram setWebhook on https://<origin>/tg-webhook/<ADMIN_TOKEN>
```

## Testing

Test endpoints (all require header `X-Admin-Token`, except the webhook path):

```
GET  /test/kimi-models   — verify Kimi API key and model name
POST /test/score         — score a sample order end-to-end
POST /test/tick          — run one full pipeline tick manually
```

Before enabling/enlarging `[triggers] crons`, run the tick test and confirm cards arrive in Telegram. After changing `wrangler.toml` bindings, run `wrangler types` and `npm run typecheck`.

## Operational notes

- First deploy of a fresh clone: create KV namespace, set the 4 secrets, run the tests above, then enable crons.
- The deployed worker already holds its secrets; CI `wrangler deploy` does not touch them.
- Alerts and digests are rate-limited on purpose — don't bypass the limits when changing `telegram.ts`.
