# AGENT.md — guidance for coding agents

## What this is

Cloudflare Worker (TypeScript) that monitors Freelancer.com via the saved-search **alerts** channel, enriches and LLM-scores new orders (Kimi API), and places bids automatically through the official Freelancer API. Cron tick: every minute. Dedup state (`seen`) and the bids ledger (`bid_ledger`) live in D1 (`DB` binding); KV namespace `ORDERS_KV` holds the ring-log buffer, alert/ping throttle flags, alerts auth override, and the bid mode (`test` | `live` | `off`, default `test`).

## Modes and hard rules

1. **Auto-bidding is real.** `src/bidder.ts` posts bids via the official API with OAuth (`FL_OAUTH_TOKEN`). The mode gate decides whether the POST happens:
   - `test` (default) — full pipeline runs, bid is **not** sent (card marked `[TEST] ставка НЕ отправлена`);
   - `live` — bid is placed for real; the Telegram card reports placed/failed;
   - `off` — tick exits immediately, nothing happens.
   Mode lives in KV key `mode`, switched via Telegram `/mode test|live|off` or `setMode`. Never silently flip a run to `live`.
2. **Secrets never in the repo.** `KIMI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_TOKEN`, `FL_OAUTH_TOKEN` exist only as Worker secrets / `.dev.vars` (gitignored). Never commit them, never log them.
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

Pipeline per cron tick, all in `src/`:

- `index.ts` — entry: scheduled tick + admin test endpoints under `/test/*` + Telegram webhook (`/tg-webhook/<ADMIN_TOKEN>`) with operator commands
- `sources/freelancer-alerts.ts` — единственный канал: saved-search alerts (`GET https://www.freelancer.com/ajax-api/navigation/recent-saved-search-alerts.php`, заголовок `freelancer-auth-v2: <userId>;<hash>` + `freelancer-app-name/platform`). Обрабатываются только записи `type==="single"` (есть `project_id`), курсор — KV `alerts:last_ts` (unix sec, только `time_updated > lastTs`). Bootstrap: ключа нет → курсор = now, пустой результат (бэклог не тащим). 401/UNAUTHORIZED → `authFailed` → Telegram-alert с throttle KV `alerts:auth_alerted` (TTL 1ч). Auth: KV `fl:auth` (`{userId, hash}`) перекрывает env `FL_USER_ID`/`FL_AUTH_HASH`, задаётся через `POST /admin/fl-auth` (X-Admin-Token); `GET /admin/fl-auth` → `{overrideSet}` без значений
- `enrich.ts` — `fetchProjectsByIds` (проекты по id из алертов; фильтр `projects[]`, не `ids[]`) и `fetchOwnerInfo` (публичный `users/0.1`, reputation/employer_reputation; `payment_verified` и открытые заказы анонимно недоступны — `null`). Инфа о заказчике кладётся в `order.owner` и уходит в JSON скорингу
- `parser.ts` — только `normalizeProject` (Freelancer project → `Order`, бюджеты пересчитываются в USD через `currency.exchange_rate`, `owner_id` извлекается в `Order`)
- `service.ts` — D1 dedup (table `seen`: id/source/status/reason/ts, retention 30 days, daily cleanup), alert-гейт `markAlertSeen` (единственный статический фильтр: bids > 5 → rejected `rej:bids>5`, source `alert`), `markRejected` (внешние отказы, напр. `rej:no-bids`), `seenStats24h` для `/status`
- `bids-balance.ts` — баланс bids. Основной источник: read-only `ajax-api/projects/getBidLimit.php` (веб-авторизация freelancer-auth-v2, как у alerts) — отдаёт `bidsRemaining`, `bidLimit`, `bidRefreshTime` (сек до регена); официальный API баланс не отдаёт. Fallback — леджер D1 (`bid_ledger`, миграция `0002_bid_ledger.sql`): `balance = lastKnown + floor((now - lastTs) / 7.5ч) - spent`, кап 100; `/setbids N` — ручная сверка. `balance === 0` в тике → заказы не скорятся, seen со status rejected `rej:no-bids` (alerts без возврата — иначе зависнут)
- `bidder.ts` — `placeBid`: pre-flight свежий bid_count (bids > 10 → cancel), обратный пересчёт USD → валюта проекта, POST `/bids/` с `Freelancer-OAuth-V1`; успех → `recordBidSpent`. Возвращает `BidResult {placed, bidId?, reason?}`; mode `test`/`off` и отсутствие OAuth/текста — причины отказа, не исключения
- `kimi.ts` — LLM scoring, JSON-schema output, retries, validation; `scoreOrder` сам подтягивает bids-баланс в контекст
- `prompts.ts` — scoring prompts (value-score + стек); operator-facing fields (`reason`, `red_flags`, `check_manually`, `deadline_caveat`, `summary_ru`) are written in Russian by design
- `telegram.ts` — карточки только для вердикта BID (PASS в Telegram не идёт), alerts throttled to 1/hour
- `mode.ts` — `getMode`/`setMode`, KV `mode`, default `test`
- `config.ts` / `types.ts` — typed env config, shared types

Non-secret tunables live in `wrangler.toml` `[vars]` (model, API bases, thresholds, `TARGET_HOURLY`, `BID_MIN_SCORE`). Change them there, not in code.

## Telegram commands (webhook `/tg-webhook/<ADMIN_TOKEN>`)

Принимаются только от `TELEGRAM_CHAT_ID` (проверка `chat.id` апдейта):

- `/mode test|live|off` — переключить режим, ответ «режим: X»
- `/status` — режим, баланс bids (леджер), статистика seen за 24ч из D1

Webhook регистрируется один раз: `POST /test/set-webhook` (header X-Admin-Token) — вызывает Telegram setWebhook на `https://<origin>/tg-webhook/<ADMIN_TOKEN>`.

## rules/ — single source of truth for selection logic

`rules/` holds the selection rules and response skill. **The LLM receives their actual file content** — `scripts/gen-rules.mjs` embeds `rules/freelancer-правила-отбора.md` и `rules/отклик-скилл.md` into `src/generated/rules.ts` (gitignored), which `src/prompts.ts` injects into the scoring and bid-text system prompts. The script runs automatically via `pretypecheck`/`predeploy` npm hooks (CI included); run `npm run gen:rules` manually after a fresh clone. **Never write selection rules inline in `prompts.ts`** — the code wrapper there carries only the code contract (JSON output schema, weekly-limit default from env, upgrade pick heuristics, language rules). When changing selection behavior, edit the markdown; pricing/scoring values live in the "Ценообразование при скоринге" section of `rules/freelancer-правила-отбора.md`.

## Post-scoring rules (deterministic, LLM does not decide these)

- **Weekly limit (hourly):** final `weekly_limit_hours = min(LLM value or DEFAULT_WEEKLY_LIMIT, DEFAULT_WEEKLY_LIMIT, 40)` (`clampWeeklyLimit`). LLM may lower it for a tight deadline, never raise it.
- **Fee/net:** fixed — 10% with $5 minimum; hourly — flat 10%, no minimum.
- **No budget floors.** Budget/rate thresholds were deliberately removed: static filters and post-scoring validation never reject by price (no `MIN_BUDGET_USD`/`MIN_FIXED_USD`/`MIN_HOURLY_USD`). Cheap orders (incl. low INR budgets) reach the LLM, which decides price fitness in the verdict.
- **Value-score:** scoring выдаёт `value_score` (0–100) и `ai_hours`; карточка показывает `🎯 Value: N/100 (~$X/ч при Y AI-ч)`. Порог BID по value_score — `BID_MIN_SCORE` из `wrangler.toml`.

Note: platform-specific selection rules live in `rules/freelancer-*.md`. More platforms (Upwork etc.) are planned — each platform will have slightly different selection rules, so keep platform-specific logic separated from the common pipeline (parser per platform, shared dedup/scoring/card layers).

## Testing

Test endpoints (all require header `X-Admin-Token`, except the webhook path):

```
GET  /test/kimi-models   — verify Kimi API key and model name
POST /test/score         — score a sample order end-to-end (пустое тело — возьмёт первый свежий алерт)
POST /test/tick          — run one full pipeline tick manually
```

Before enabling/enlarging `[triggers] crons`, run the tick test and confirm cards arrive in Telegram. After changing `wrangler.toml` bindings, run `wrangler types` and `npm run typecheck`.

## Operational notes

- **KV free tier = 1000 put / 1000 list / 100k read ops per day** (daily, not monthly). The code is shaped around this: the ring log buffers info entries in isolate memory and flushes once per tick with activity (`flushLogBuffer`), `markStatus` does not exist (status trail lives in the ring log and D1 `seen`). Seen-dedup was moved to D1 (`migrations/0001_seen.sql`) precisely because KV puts exceeded the free tier; only a few KV writes remain (seen-cleanup flag, alert throttle keys, alerts cursor, `mode`). When adding KV writes, count them against the daily budget.
- **D1 limits:** max 100 bound parameters per query — dedup batches accordingly (SELECT by ≤100 id, INSERT ≤20 rows). Remote migration applied via `wrangler d1 migrations apply freelancer-monitor --remote`.
- First deploy of a fresh clone: create KV namespace, set the secrets, run the tests above, then enable crons.
- The deployed worker already holds its secrets; CI `wrangler deploy` does not touch them.
- Alerts are rate-limited on purpose (1/hour) — don't bypass the limit when changing `telegram.ts`. Card sending is intentionally unlimited.
- `live`-режим требует валидный `FL_OAUTH_TOKEN` и `FL_USER_ID`; без них `placeBid` возвращает reason (`oauth-missing` / `fl-user-id-missing`), карточка придёт с «⚠️ Отклик НЕ отправлен».

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
