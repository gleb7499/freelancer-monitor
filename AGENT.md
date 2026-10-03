# AGENT.md — guidance for coding agents

## What this is

Cloudflare Worker (TypeScript) that monitors Freelancer.com for new orders in 12 niches, filters and LLM-scores them (Kimi API), and sends Telegram cards with a bid draft. Cron tick: every minute. Dedup state (`seen`) lives in D1 (`DB` binding); KV namespace `ORDERS_KV` is used for ring logs, bid cards, and alert/ping flags.

## Hard rules (never violate)

1. **No auto-bidding.** The worker only monitors and sends cards. A human submits every bid manually. `src/bidder.ts` is a logging-only stub: with `AUTOBID_ENABLED=false` (default) it does nothing; even when enabled it only logs. Do not add any code that actually posts bids or applies to projects.
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
- `parser.ts` — Freelancer API → `Order[]` (`fetchAllNiches` + `fetchProjectsByIds` для alert-канала, фильтр `projects[]`, не `ids[]`); бюджеты пересчитываются в USD через `currency.exchange_rate`, оригинальные суммы и код валюты сохраняются для карточки
- `sources/freelancer-alerts.ts` — второй канал: saved-search alerts (`GET https://www.freelancer.com/ajax-api/navigation/recent-saved-search-alerts.php`, заголовок `freelancer-auth-v2: <userId>;<hash>` + `freelancer-app-name/platform`). Обрабатываются только записи `type==="single"` (есть `project_id`), курсор — KV `alerts:last_ts` (unix sec, только `time_updated > lastTs`). Bootstrap: ключа нет → курсор = now, пустой результат (бэклог не тащим). 401/UNAUTHORIZED → `authFailed` → Telegram-alert с throttle KV `alerts:auth_alerted` (TTL 1ч). Auth: KV `fl:auth` (`{userId, hash}`) перекрывает env `FL_USER_ID`/`FL_AUTH_HASH`, задаётся через `POST /admin/fl-auth` (X-Admin-Token); `GET /admin/fl-auth` → `{overrideSet}` без значений
- `service.ts` — D1 dedup (table `seen`: id/source/status/reason/ts, retention 30 days, daily cleanup), static filters (bids > 50 — жёсткий отсев на обоих каналах, language, fulltime, deadline), niche rotation (`pickNiches`, 4 niches/tick, full pass 3 min). Бюджет/ставка НЕ фильтруются — ценовая пригодность решает только LLM. Alert-заказы идут тем же дедупом, без staticReject (Freelancer уже отфильтровал по сохранённому поиску), кроме bids > 50 — `markAlertSeen` возвращает прошедшие заказы и пишет source `alert`
- `bidder.ts` — авто-отклик заглушка: при `AUTOBID_ENABLED=false` только логирует `autobid.skipped`; реального размещения ставок нет
- `kimi.ts` — LLM scoring, JSON-schema output, retries, validation
- `prompts.ts` — scoring prompts; operator-facing fields (`reason`, `red_flags`, `check_manually`, `deadline_caveat`, `summary_ru`) are written in Russian by design
- `telegram.ts` — cards sent as they come (no rate limit), alerts throttled to 1/hour
- `config.ts` / `types.ts` / `niches.ts` — typed env config, shared types, 12 niche definitions

Non-secret tunables live in `wrangler.toml` `[vars]` (model, API bases, thresholds, limits). Change them there, not in code.

## rules/ — single source of truth for selection logic

`rules/` holds the selection rules, niche list, query syntax, and response skill. **The LLM receives their actual file content** — `scripts/gen-rules.mjs` embeds `rules/freelancer-правила-отбора.md` and `rules/отклик-скилл.md` into `src/generated/rules.ts` (gitignored), which `src/prompts.ts` injects into the scoring and bid-text system prompts. The script runs automatically via `pretypecheck`/`predeploy` npm hooks (CI included); run `npm run gen:rules` manually after a fresh clone. **Never write selection rules inline in `prompts.ts`** — the code wrapper there carries only the code contract (JSON output schema, weekly-limit default from env, upgrade pick heuristics, language rules). When changing selection behavior, edit the markdown; pricing/scoring values live in the "Ценообразование при скоринге" section of `rules/freelancer-правила-отбора.md`.

## Post-scoring rules (deterministic, LLM does not decide these)

- **Weekly limit (hourly):** final `weekly_limit_hours = min(LLM value or DEFAULT_WEEKLY_LIMIT, DEFAULT_WEEKLY_LIMIT, 40)` (`clampWeeklyLimit`). LLM may lower it for a tight deadline, never raise it.
- **Fee/net:** fixed — 10% with $5 minimum; hourly — flat 10%, no minimum.
- **No budget floors.** Budget/rate thresholds were deliberately removed: static filters and post-scoring validation never reject by price (no `MIN_BUDGET_USD`/`MIN_FIXED_USD`/`MIN_HOURLY_USD`). Cheap orders (incl. low INR budgets) reach the LLM, which decides price fitness in the verdict.
- **TEMPORARY (debug, remove after LLM tuning):** PASS verdicts also get a Telegram card (`🔍 DEBUG PASS` prefix) so the operator can audit LLM rejections in person.

Note: platform-specific selection rules live in `rules/freelancer-*.md`. More platforms (Upwork etc.) are planned — each platform will have slightly different selection rules, so keep platform-specific logic separated from the common pipeline (parser per platform, shared dedup/scoring/card layers).

## Response tracking (Telegram inline button)

BID cards carry an inline button «Откликнулся ✅» (`callback_data: "applied:{id}"`). Telegram callbacks arrive at the webhook path `/tg-webhook/{ADMIN_TOKEN}` (authorized by the token in the URL, not a header). Pressing writes `applied:{id}` to KV and removes the pending record.

KV keys:

- `bidcard:{id}` — `{sent_at, title, project_id}`, written when a BID card is sent (TTL 24h). Each tick, `pingUnappliedBids` pings orders older than 25 minutes without `applied:{id}` with one short message «Не откликнулся: {title}», then deletes the key (one ping only).
- `applied:{id}` — confirmation timestamp (TTL 24h).

The webhook must be registered once after deploy (or after the worker URL changes):

```
POST /test/set-webhook   (header X-Admin-Token) — calls Telegram setWebhook on https://<origin>/tg-webhook/<ADMIN_TOKEN>
POST /admin/fl-auth      — body {userId, hash}: горячая замена freelancer-auth-v2 без редеплоя (KV `fl:auth`, без TTL)
GET  /admin/fl-auth      — {overrideSet: boolean}, значения не отдаются
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

- **KV free tier = 1000 put / 1000 list / 100k read ops per day** (daily, not monthly). The code is shaped around this: niche rotation is time-based (no KV), the ring log buffers info entries in isolate memory and flushes once per tick with activity (`flushLogBuffer` at the end of `runTick`), unapplied-bid ping runs at most every 15 minutes, `markStatus` does not exist (status trail lives in the ring log). Seen-dedup was moved to D1 (`migrations/0001_seen.sql`) precisely because KV puts exceeded the free tier; only one KV write per day remains for the seen-cleanup flag (`seen:cleanup:last`). When adding KV writes, count them against the daily budget.
- **D1 limits:** max 100 bound parameters per query — dedup batches accordingly (SELECT by ≤100 id, INSERT ≤20 rows). Remote migration applied via `wrangler d1 migrations apply freelancer-monitor --remote`.
- First deploy of a fresh clone: create KV namespace, set the 4 secrets, run the tests above, then enable crons.
- The deployed worker already holds its secrets; CI `wrangler deploy` does not touch them.
- Alerts are rate-limited on purpose (1/hour) — don't bypass the limit when changing `telegram.ts`. Card sending is intentionally unlimited.

<!-- serena-memory:v1 -->
## Project Memory (Serena)

This project uses the Serena MCP server for persistent project memory and
symbol-level code navigation.

- Memories live in `.serena/memories/*.md` (project overview, architecture,
  conventions, commands, decisions). Read them before exploring the codebase
  from scratch: call serena `list_memories`, then `read_memory` for what is
  relevant. Trust them, but verify against the code when they look stale.
- Prefer serena symbolic tools (`get_symbols_overview`, `find_symbol`,
  `find_referencing_symbols`) over reading whole files — they are cheaper.
- At the end of a session that changed architecture, module structure,
  conventions, or key decisions, update the memories with `write_memory`.
  Do not wait to be asked. Small code edits that change none of the above
  need no memory update.
- If memories are missing, run serena `onboarding` to regenerate them.
