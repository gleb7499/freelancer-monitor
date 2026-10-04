# AGENT.md — guidance for coding agents

## What this is

Cloudflare Worker (TypeScript) that monitors Freelancer.com via the official public **projects/active** API (poll every 10 s, 11 skills, newest first), enriches and LLM-scores new orders (Kimi API), and places bids automatically through the official Freelancer API. Tick loop: Durable Object `TickScheduler` alarm every 10 s (cron `* * * * *` is only a watchdog that wakes the DO if the alarm chain broke). Dedup state (`seen`) and the bids ledger (`bid_ledger`) live in D1 (`DB` binding); KV namespace `ORDERS_KV` holds the ring-log buffer, alert/ping throttle flags, web-auth override (для getBidLimit), and the bid mode (`test` | `live` | `off`, default `test`).

## Modes and hard rules

1. **Auto-bidding is real.** `src/bidder.ts` posts bids via the official API: основной путь — OAuth (`FL_OAUTH_TOKEN`), фолбэк — `Authorization: Bearer <FL_API_KEY>` (ключ Develop API; авторизация проверена 04.10.2026). The mode gate decides whether the POST happens:
   - `test` (default) — full pipeline runs, bid is **not** sent (card marked `[TEST] ставка НЕ отправлена`);
   - `live` — bid is placed for real; the Telegram card reports placed/failed;
   - `off` — tick exits immediately, nothing happens.
   Mode lives in KV key `mode`, switched via Telegram `/mode test|live|off` or `setMode`. Never silently flip a run to `live`.
2. **Secrets never in the repo.** `KIMI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_TOKEN`, `FL_USER_ID`, `FL_AUTH_HASH`, `FL_API_KEY` exist only as Worker secrets / `.dev.vars` (gitignored). `FL_OAUTH_TOKEN` — опционален (в проде на 04.10.2024 отсутствует; рабочая авторизация — Bearer-ключ). Never commit them, never log them.
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

Pipeline per tick (every 10 s via DO alarm), all in `src/`:

- `index.ts` — entry: scheduled tick + admin test endpoints under `/test/*` + Telegram webhook (`/tg-webhook/<ADMIN_TOKEN>`) with operator commands
- `sources/freelancer-active.ts` — единственный канал: официальный публичный API `GET {FREELANCER_API_BASE}/projects/active/` (без auth, без кук). Параметры: 11 скиллов `jobs[]` (9,323,607,741,759,979,1002,1042,2370,2376,2703 — как у saved search «Main Search»), `project_types[]=fixed|hourly`, `languages[]=en`, `sort_field=submitdate`, limit 25, full_description. Курсор — KV `active:last_submit` (unix sec, только `submitdate > cursor`); bootstrap — now-300 c (последние 5 минут). Опрос каждый тик DO (10 с; throttle KV `active:last_fetch` защищает от повторов внутри тика). Записи нормализуются `normalizeProject` из parser.ts
- `enrich.ts` — `fetchProjectsByIds` (проекты по id), `fetchProjectClient` (открытая точка `projects/seo` по seo_url: verification/рейтинг/открытые заказы заказчика + `skill_ids` проекта → `order.client` в JSON скорингу и в пре-гейт) и `fetchPortfolio` (портфолио профиля через Develop API, кэш KV `portfolio:cache` 6 ч; уходит в контекст генерации текста ставки). `CRYPTO_SKILL_ID = 2658`
- `parser.ts` — только `normalizeProject` (Freelancer project → `Order`, бюджеты пересчитываются в USD через `currency.exchange_rate`; `owner_id` анонимно всегда null — поле удалено)
- `service.ts` — D1 dedup (table `seen`: id/source/status/reason/ts, retention 30 days, daily cleanup), `markAlertSeen` — жёсткий гейт до LLM (возвращает `{kept, rejected: {order, reason}[]}`): bids > 10 (`rej:bids>10`) и мягкий пре-гейт физической возможности ставки `preBidRejectReason` — recruiter (`rej:recruiter`), `is_seller_kyc_required` (`rej:kyc-required`), крипто-скилл 2658 из ответа projects/seo (`rej:crypto-verified`). Требует enrich ДО вызова; `seenStats24h` для `/status`
- `bids-balance.ts` — баланс bids. Основной источник: read-only `ajax-api/projects/getBidLimit.php` (веб-авторизация freelancer-auth-v2) — отдаёт `bidsRemaining`, `bidLimit`, `bidRefreshTime`; официальный API баланс не отдаёт. Fallback — леджер D1 (`bid_ledger`, миграция `0002_bid_ledger.sql`): реген 1 bid / 7.5 ч, кап 100. `balance === 0` в тике → idle (опрос и LLM остановлены), заказы не помечаются — курсор стоит, при восстановлении баланса выдача догоняется
- `bidder.ts` — `placeBid`: pre-flight свежий bid_count (bids > 10 → cancel), ставка уже в валюте проекта (пересчёта нет), POST `/bids/` (OAuth или Bearer-ключ); `milestone_percentage` 30% для fixed ≥ ~$150 или клиента без верификации, иначе 100; детект ошибки минимального баланса (~$20) по словам balance/deposit/funds/insufficient → reason `insufficient-balance`. Успех → `recordBidSpent`. Возвращает `BidResult {placed, bidId?, reason?}`; mode `test`/`off` и отсутствие токенов/текста — причины отказа, не исключения
- `milestones.ts` — каждый тик (throttle KV `ms:last_check`, 5 мин): `GET /bids/?bidders[]=<мы>` → детект назначенных ставок (эвристика: `time_awarded` число или статус со «award»/«accept»; сырые поля логируются `milestones.awarded-bid`) → kickoff-запрос `milestone_requests` на 30% ставки (fixed ≥ ~$100, дедуп KV `ms:req:<bid_id>`, TTL 30 дней) → уведомление в Telegram
- `kimi.ts` — LLM scoring, JSON-schema output, retries, validation; кодовый пересчёт value_score в USD; округление ставки до сетки (шаг по величине), пол 70% середины вилки, кап 150%; `sanitizeBidText` — ASCII-only пост-проход текста ставки; `scoreOrder` сам подтягивает bids-баланс в контекст
- `prompts.ts` — кодовая обвязка промптов (контракт JSON, value-score механика, апгрейды: первая пятёрка — только sealed; 6–10 — на усмотрение LLM; семантика полей `order.client`; plaintext-контракт текста ставки). Правила отбора — только из rules/*.md
- `telegram.ts` — карточки: полная для BID, компактная `formatPassCard` для PASS в test-режиме, `formatRejectCard` для гейта; alerts throttled to 1/hour
- `mode.ts` — `getMode`/`setMode`, KV `mode`, default `test`
- `config.ts` / `types.ts` — typed env config, shared types

Non-secret tunables live in `wrangler.toml` `[vars]` (model, API bases, thresholds, `TARGET_HOURLY`, `BID_MIN_SCORE`). Change them there, not in code.

## Иерархия API Freelancer

- **Приоритет 1 — открытые (публичные, без авторизации) точки API** (достаточно User-Agent обычного браузера):
  - `projects/0.1/projects/active` — выдача новых проектов (основной канал);
  - `projects/0.1/projects/seo` — данные заказчика по seo_url: verification (payment_verified, deposit_made и т.д.), рейтинг работодателя, `other_employer_jobs` (проверено 04.10.2026);
  - `users/0.1/users/{id}` — reputation/employer_reputation; `payment_verified` анонимно не отдаёт.
- **Приоритет 2 — закрытые точки официального Develop API.** Авторизация работает заголовком `Authorization: Bearer <FL_API_KEY>` (и `Freelancer-OAuth-V1`; проверено 04.10.2026 на `/projects/0.1/bids/`). Ключ хранится в секретах (`FL_API_KEY`), не в коде и не в логах.
  - `projects/0.1/milestone_requests/` — запрос этапного платежа исполнителем: `POST {project_id, bid_id, amount, description}`; работодатель принимает → этап создан и профинансирован (проверено 04.10.2026, SDK: [create_milestone_request](https://github.com/freelancer/freelancer-sdk-python/blob/master/examples/create_milestone_request.py)).
  - `projects/0.1/milestones/` — создание (`POST {project_id, bidder_id, amount, reason, description}`), release (`PUT /milestones/{id}/` с `action=release` / `request_release`), отмена (`DELETE`).
- **Приоритет 3 — закрытый приватный API freelancer.com** (внутренние точки веб-приложения) — только если данных нет в приоритетах 1–2.
- Правило: секреты только через env/секреты wrangler; значения токенов в логи, отчёты и коммиты не выводить.

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

Note: platform-specific selection rules live in `rules/freelancer-*.md`. The pipeline is platform-shaped (parser per platform, shared dedup/scoring/card layers) — при появлении второй площадки её правила добавляются как отдельный файл rules/, без переломки общего конвейера.

## Testing

Offline acceptance (no network, no secrets — чистая логика с моками fetch/KV):

```bash
npm run acceptance   # 63 проверки: скоринг-математика, сетка округления, валюты,
                     # fee, пол/кап, санитайзер, isAwarded, парсинг client/portfolio,
                     # карточки (лимит 4096), потолок апгрейдов
```

Test endpoints (all require header `X-Admin-Token`, except the webhook path):

```
GET  /test/kimi-models   — verify Kimi API key and model name
POST /test/score         — score a given order JSON end-to-end (пустое тело — свежий заказ из active)
POST /test/tick          — run one full pipeline tick manually
POST /test/milestones    — скан назначенных ставок; dry-run по умолчанию, {"dryRun": false} — реальные запросы
GET  /test/logs          — кольцевой лог
GET  /test/bids-balance  — баланс bids
POST /test/set-webhook   — регистрация webhook Telegram (один раз)
```

Before enabling/enlarging `[triggers] crons`, run the tick test and confirm cards arrive in Telegram. After changing `wrangler.toml` bindings, run `wrangler types` and `npm run typecheck`.

## Local development

- `npx wrangler dev` читает `.dev.vars`; локально там **нет** `FL_OAUTH_TOKEN` — закрытые точки и ставки тестируются с `--var FL_API_KEY:<ключ>` (Bearer-фолбэк).
- Локальная проверка `/test/*` без `ADMIN_TOKEN`: временно добавить обход в `isAuthorized` (`src/index.ts`), проверить, **обязательно убрать до коммита**.
- Временный файл приёмки исторически лежал в `tmp/` (в gitignore) — теперь стенд живёт в `scripts/acceptance.ts`.

## Operational notes

- **KV free tier = 1000 put / 1000 list / 100k read ops per day** (daily, not monthly). The code is shaped around this: the ring log buffers info entries in isolate memory and flushes once per tick with activity (`flushLogBuffer`), `markStatus` does not exist (status trail lives in the ring log and D1 `seen`). Seen-dedup was moved to D1 (`migrations/0001_seen.sql`) precisely because KV puts exceeded the free tier; only a few KV writes remain (seen-cleanup flag, alert throttle keys, active cursor, `mode`). When adding KV writes, count them against the daily budget.
- **D1 limits:** max 100 bound parameters per query — dedup batches accordingly (SELECT by ≤100 id, INSERT ≤20 rows). Remote migration applied via `wrangler d1 migrations apply freelancer-monitor --remote`.
- First deploy of a fresh clone: create KV namespace, set the secrets, run the tests above, then enable crons.
- The deployed worker already holds its secrets; CI `wrangler deploy` does not touch them.
- Alerts are rate-limited on purpose (1/hour) — don't bypass the limit when changing `telegram.ts`. Card sending is intentionally unlimited.
- `live`-режим требует `FL_USER_ID` и хотя бы один токен авторизации (`FL_OAUTH_TOKEN` или `FL_API_KEY`); без них `placeBid` возвращает reason (`oauth-missing` / `fl-user-id-missing`), карточка придёт с «⚠️ Отклик НЕ отправлен». Ошибка «минимальный баланс ~$20» детектится по тексту ответа и уходит отдельным алертом.

## Production state (2026-10-04)

- **Режим: `live`.** Переключение: Telegram `/mode ...` или
  `npx wrangler kv key put mode live --namespace-id b629829e784842d3a9c78f612f689974`
  (namespace id — из `wrangler.toml`). Перед переводом в live — полный цикл приёмки (см. ниже).
- Воркер: `https://freelancer-monitor.ksenia.workers.dev` (поддомен аккаунта — `ksenia`).
  Health-check: `curl` на корень → **ожидаем HTTP 404** (это «жив»; 000/5xx — проблема).
- Аккаунт фрилансера: `gleb7499` (id 94242579). Секреты в проде (7): ADMIN_TOKEN,
  FL_AUTH_HASH, FL_USER_ID, KIMI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, FL_API_KEY.
  `FL_OAUTH_TOKEN` отсутствует — рабочая авторизация ставок/этапов/портфолио — Bearer-ключ.
- Порядок выкладки изменений (установленный паттерн): правки → `npm run typecheck` +
  `npm run acceptance` → commit → push в `main` (CI деплоит сама: typecheck → wrangler deploy) →
  проверить `gh run list` (success) → `wrangler deployments list` (свежая версия) → health-check.
  Для крупных изменений перед live: 10 минут наблюдения каждые 20 сек (воркер + CI), затем
  перевод режима, затем 20 минут дебаг-окна.
- Важно: `wrangler secret put` не требует деплоя — секрет подхватывается сразу, но код,
  который его читает, должен быть задеплоен.

## Работа с оператором (Gleb)

- Telegram-чат бота — основной интерфейс: Gleb шлёт туда скриншоты/карточки и **комментарии,
  которые являются задачами** («пусть LLM…», «нужно дать придирчивому клиенту…»). Каждый
  комментарий — отдельная доработка правил/кода.
- Ошибки/аномалии из карточек («⚠️ Отклик НЕ отправлен: X») — первичный источник баг-репортов:
  reason из `BidResult` диагностирует причину без логов.
- Русский язык без англицизмов (глобальное правило пользователя); идентификаторы, имена файлов,
  API, команды — как есть.
- Пользователь принимает решения через утверждение плана; при сомнениях в трактовке
  комментария — уточнить одиночным вопросом (история: «дать придирчивому клиенту почитать
  отклики» оказалось задачей-критикой откликов, а не фичей архива).

## Проверенные факты API (дополнение к иерархии)

- `GET /projects/0.1/bids/?bidders[]=<id>` отдаёт наши ставки с полями назначения:
  `award_status`, `frontend_bid_status`, `time_awarded`, `time_accepted`, `complete_status`,
  `paid_status`, `milestone_percentage`. Детект назначения — эвристика (см. milestones.ts),
  **не подтверждён живым назначением**: по первому реальному случаю сверить лог
  `milestones.awarded-bid` и подточить `isAwarded`.
- `POST /milestone_requests/` создаёт запрос **даже без назначения** (status pending).
  Удаление тестового запроса: `PUT /milestone_requests/{id}/` с телом `{action:"delete"}`.
  DELETE-метод — 405.
- Авторизация Bearer-ключом для `POST /bids/` проверена косвенно: фейковый `project_id=0` →
  HTTP 500 (валидация), а не 401. Первая реальная live-ставка всё ещё ждёт подтверждения.
- `GET /users/0.1/portfolios/?users[]=<id>` (Bearer) — элементы портфолио: `title`,
  `description` (внутри живут демо-ссылки), `files`. Профиль: `https://www.freelancer.com/u/<username>`
  (username анонимно отдаёт `users/0.1/users/{id}?compact=true`).
- Часть заказов требует минимальный баланс ~$20 на счёту для ставки — текст ошибки ловим
  по словам balance/deposit/funds/insufficient (реальный текст ещё не видели).
- **Cryptocurrency-проекты требуют верификации аккаунта (Freelancer Verified)** — иначе
  POST bids → 403 `RESTRICTED_FROM_BIDDING_PREMIUM_VERIFIED_JOB` (проверено 04.10.2026).
  Наш аккаунт не верифицирован → крипто-проекты в правилах отсечены на уровне скоринга.
- **Recruiter-проекты (бейдж RECRUITER, `upgrades.recruiter=true`) — только для Preferred
  Freelancer**; наш аккаунт не подходит. Код режет такие ставки до POST (reason `preferred-only`).
  Оба ограничения нередко стоят на одном проекте одновременно.
- `projects/seo` `result.client`: `verification{payment_verified, deposit_made, email_verified,
  phone_verified, profile_complete}`, `rating{average, review_count}`, `registration_unixtime`,
  `address`; `other_employer_jobs` — примерный список открытых заказов клиента.

## Продуктовые решения (контекст, почему код устроен так)

- Ставка — **середина вилки**, якорь ~$10/ч на руки: заказы видны системой через секунды
  после публикации, 0 откликов ничего не значит, конкуренты идут ближе к середине.
  (Подробности и пороги — в rules/freelancer-правила-отбора.md, не дублировать в код.)
- Скидка за новизну аккаунта — только цифрой и только вместе с блоком «новый профиль»;
  иначе новизну не упоминать. Портфолио-ссылка убедительнее акцента на новизне.
- `order.client` полностью в null → LLM взвешивает риск сама (авто-BID/авто-PASS запрещены).
- Этапность: предоплата 30–40% предлагается в тексте отклика и ставится в
  `milestone_percentage` самой ставки для fixed ≥ ~$150 или клиента без верификации;
  авто-запрос kickoff-этапа 30% — после назначения (milestones.ts).
- Текст ставки — строго plain text ASCII (санитайзер постфактум): платформа коверкает
  юникод-типографику и Markdown.

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
