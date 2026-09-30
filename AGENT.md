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
- `parser.ts` — Freelancer API → `Order[]` (`fetchAllNiches`)
- `service.ts` — KV dedup (`seen:*`), static filters (bids, budget, language, fulltime, deadline), niche rotation (`pickNiches`, 4 niches/tick, full pass 3 min)
- `kimi.ts` — LLM scoring, JSON-schema output, retries, validation
- `prompts.ts` — scoring prompts; operator-facing fields (`reason`, `red_flags`, `check_manually`, `deadline_caveat`, `summary_ru`) are written in Russian by design
- `telegram.ts` — cards, 5 cards/hour limit, overflow digest, alerts throttled to 1/hour
- `config.ts` / `types.ts` / `niches.ts` — typed env config, shared types, 12 niche definitions

Non-secret tunables live in `wrangler.toml` `[vars]` (model, API bases, thresholds, limits). Change them there, not in code.

## rules/ — single source of truth for selection logic

`rules/` holds the original selection rules, niche list, and response skill. They are the spec that `niches.ts`, `service.ts` filters, and `prompts.ts` encode. When changing selection behavior, update the code **and** check whether `rules/` needs to reflect the new logic.

## Testing

Test endpoints (all require header `X-Admin-Token`):

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
