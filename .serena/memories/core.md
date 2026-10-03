# Freelancer-monitor — project core

Cloudflare Worker (TS), cron every minute: scans Freelancer.com orders in 12 niches, dedup + static filters, LLM scoring (Kimi), Telegram cards with bid draft. Human submits every bid manually.

`AGENT.md` in repo root is the authoritative, up-to-date architecture doc — read it first for any non-trivial task. It documents the 4-layer pipeline, KV/D1 key layout, test endpoints, and operational limits (KV free tier, D1 100-param limit).

## Source map (src/)
- `index.ts` — entry: scheduled tick, `/test/*` and `/admin/*` endpoints, `/tg-webhook/{ADMIN_TOKEN}`
- `parser.ts` — Freelancer API → `Order[]`; budgets converted to USD via `currency.exchange_rate`
- `sources/freelancer-alerts.ts` — second channel: saved-search alerts, cursor in KV `alerts:last_ts`, auth override KV `fl:auth`
- `service.ts` — D1 dedup (table `seen`, retention 30d), static filters, niche rotation (`pickNiches`, 4/tick)
- `kimi.ts` — LLM scoring, JSON-schema output, retries, validation
- `prompts.ts` — scoring prompts; only code contract (JSON schema) here, NEVER selection rules
- `telegram.ts` — cards unlimited, alerts throttled 1/hour
- `bidder.ts` — autobid stub, logging only
- `logger.ts` — ring log in KV, buffered flush once per tick
- `upgrades.ts`, `config.ts`, `types.ts`, `niches.ts` — heuristics, typed env, shared types, 12 niches

## Invariants
- **No auto-bidding anywhere** — hard red line (`AGENT.md` rule 1).
- **Secrets never in repo/logs**: `KIMI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_TOKEN` — only Worker secrets / `.dev.vars` (gitignored). Repo is public.
- Selection rules live ONLY in `rules/*.md`, embedded at build into `src/generated/rules.ts` (gitignored) via `scripts/gen-rules.mjs` — see `mem:conventions`.
- No budget/rate price floors anywhere — price fitness decided by LLM only.
- Platform-specific logic (parser, rules `freelancer-*.md`) stays separated from shared pipeline — more platforms planned.

Related: `mem:tech_stack`, `mem:suggested_commands`, `mem:conventions`, `mem:task_completion`.
