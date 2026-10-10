# AGENT.md — guidance for coding agents

## What this is

Cloudflare Worker (TypeScript) that monitors Freelancer.com via **two intake channels** — the closed web API project feed (`ajax-api/navigation/project-feed/pre-populated.php`, web auth header `freelancer-auth-v2`) and the public frontend search `api/projects/0.1/projects/active` (no auth) — merges and dedups orders by id, enriches and LLM-scores new orders (Kimi API), and places bids automatically through the **closed web API of the frontend** (header `freelancer-auth-v2`, same as the feed channel). Tick loop: Durable Object `TickScheduler` alarm every 20 s (cron `* * * * *` is only a watchdog that wakes the DO if the alarm chain broke). Dedup state (`seen`) and the bids ledger (`bid_ledger`) live in D1 (`DB` binding); KV namespace `ORDERS_KV` holds the ring-log buffer, alert/ping throttle flags, web-auth override (для getBidLimit и всех закрытых веб-точек, KV `fl:auth`), and the bid mode (`test` | `live` | `off`, default `test`).

## Modes and hard rules

1. **Auto-bidding is real.** `src/bidder.ts` posts bids through the closed web API of the frontend (`freelancer-auth-v2`): основной путь — веб-авторизация (KV `fl:auth`, горячая замена через `/admin/fl-auth`), фолбэк — OAuth (`FL_OAUTH_TOKEN`) либо `Authorization: Bearer <FL_API_KEY>`. Live-ставка через веб-API подтверждена 09.10.2026 (bid 496321109). Сразу после успешной ставки: все этапные запросы (`milestone_requests`, по плану из скоринга) и покупка Sealed — **всегда, кодом**, за $0.10 через корзину платежей (`payments.ts`); при OAuth-фолбэке Sealed не купить (`sealPurchase: "no-web-auth"`). The mode gate decides whether the POST happens:
   - `test` (default) — full pipeline runs, bid is **not** sent (card marked `[TEST] ставка НЕ отправлена`);
   - `live` — bid is placed for real; the Telegram card reports placed/failed;
   - `off` — tick exits immediately, nothing happens.
   Mode lives in KV key `mode`, switched via Telegram `/mode test|live|off` or `setMode`. Never silently flip a run to `live`.
2. **Secrets never in the repo.** `KIMI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_TOKEN`, `FL_USER_ID`, `FL_AUTH_HASH`, `FL_API_KEY` exist only as Worker secrets / `.dev.vars` (gitignored). `FL_OAUTH_TOKEN` — опционален (в проде отсутствует; фолбэк для ставок — Bearer-ключ, основной путь — веб-авторизация `FL_USER_ID`+`FL_AUTH_HASH`). Never commit them, never log them.
3. **Never commit `.dev.vars`.** Example file: `.dev.vars.example`.
4. Repo is public. Treat anything added to git as published.
5. **No inline prompts.** All prompt text lives in `prompts/*.md` (imported as text via the `rules` entry in `wrangler.toml`; esbuild in the acceptance script uses `--loader:.md=text`). Code in `src/prompts.ts` only substitutes `{{TOKEN}}` placeholders. JSON response schemas (machine contracts) stay in code. This is a hard project rule — new prompt text goes into a file, never into a template literal.
6. **Deploy only via GitHub CI** (`.github/workflows/deploy.yml` — push в `main` → typecheck → `wrangler deploy`). Агент НЕ деплоит напрямую (`npm run deploy` / `wrangler deploy` запрещены). Пайплайн: изменения → локальные проверки БЕЗ запуска локальной копии (typecheck, acceptance — без `wrangler dev`, без локальных серверов) → коммит → пуш сразу в `main` (или текущую рабочую ветку), без PR. Прямой деплой — только в исключительной ситуации «без этого никак», с явным уведомлением пользователя.
7. **Тестировать проект локально ЗАПРЕЩЕНО — только удалённо** (решение Gleb'а, 09.10.2026). Никаких `wrangler dev`, локальных прогонов тика/скоринга против реальных API и секретов, локальных эмуляторов с прод-данными. Единственные локальные проверки — оффлайн-логика без сети и секретов: `npm run typecheck` и `npm run acceptance`. Проверка работы системы — только на выкачанном через CI воркере (health-check, `/test/*`, `wrangler tail`, чтение KV/D1 — см. урок ниже про `--remote`). Локальный KV-эмулятор (`.wrangler/`) хранит устаревший мусор с прошлых сессий — диагноз по нему вводит в заблуждение (инцидент 09.10.2026: «застывшие курсоры» и «mode=test» оказались локальным хранилищем, прод был здоров).

## Commands

```bash
npm install          # deps
npm run typecheck    # tsc --noEmit — must pass before any commit
npm run acceptance   # оффлайн-приёмка (без сети и секретов) — тоже перед коммитом
wrangler types       # regenerate Env types after config/binding changes
```

`npm run deploy` и `wrangler dev` — НЕ использовать (правило 6/7 выше): деплой только через GitHub CI, локальные прогоны запрещены.

CI (GitHub Actions) deploys on every push to `main`: `npm ci` → `npm run typecheck` → `wrangler deploy` via `cloudflare/wrangler-action`. Requires repo secret `CLOUDFLARE_API_TOKEN`.

## Architecture

Pipeline per tick (every 20 s via DO alarm), all in `src/`:

- `index.ts` — entry: scheduled tick + admin test endpoints under `/test/*` + Telegram webhook (`/tg-webhook/<ADMIN_TOKEN>`) with operator commands
- `sources/freelancer-active.ts` — первый канал: закрытый веб-API ленты `GET https://www.freelancer.com/ajax-api/navigation/project-feed/pre-populated.php` (веб-авторизация `freelancer-auth-v2`, без кук). Параметры: 11 скиллов `jobIds[]` (9,323,607,741,759,979,1002,1042,2370,2376,2703 — как у saved search «Main Search»), `fromWebapp=true&compact=true&new_errors=true&new_pools=true`. Отбор `type === "project"` (конкурсы пропускаются). Курсор — KV `active:last_submit` по полю `time` элемента ленты (unix sec, только `time > cursor`); bootstrap — now-300 c (последние 5 минут). Throttle KV `active:last_fetch` (10 с) защищает от повторов внутри тика. Дозаполнение: батч-карточки `projects?projects[]=<id>&full_description=true&upgrade_details=true&job_details=true&owner_info=true&attachment_details=true` → `mapCardToProject` поднимает `upgrades.active_prepaid_milestone` в верхний уровень (`normalizeProject` ждёт его там), фильтр `language === "en"`. Из элемента ленты сохраняется `owner_id` (поле `userId`) → `Order.owner_id`. 401/`UNAUTHORIZED` на любой из вызовов → `logError` + разовый алерт (TTL 1 ч): обновить веб-авторизацию через `/admin/fl-auth`. Конверт ленты разбирают `parseFeedBody`/`mapFeedItem` (оба защищённые, покрыты приёмкой). Общий хелпер `ownerIdFromCard(card)` — читает `owner_info.id ?? user_id ?? owner_id` карточки (используется обоими каналами)
- `sources/freelancer-search.ts` — второй канал: публичный поиск фронта `GET {freelancerBase}/projects/active` (без авторизации, только браузерный User-Agent; исследование Gleb 08.10.2026). Параметры как у фронта: `limit=20&full_description=true&job_details=true&upgrade_details=true&owner_info=true&languages[]=en&project_types[]=hourly&project_types[]=fixed&sort_field=submitdate&webapp=1&compact=true&new_errors=true&new_pools=true` + те же 11 скиллов `jobs[]`. Конверт `{status:"success", result:{projects:[…], total_count}}`, элементы — ПОЛНЫЕ карточки (37 полей, дозаполнение не нужно): `mapCardToProject` → `normalizeProject(…, "active")`, защитные фильтры `type` fixed/hourly и `language === "en"`, `owner_id` — `ownerIdFromCard` (фолбэка нет, null допустим). Курсор — KV `search:last_submit` по `submitdate` (bootstrap now-300 с), throttle KV `search:last_fetch` (10 с). Ошибки канала возвращаются в `error` результата (имя канала в сообщении), наружу не бросаются. Разбор конверта — `parseSearchBody` (покрыт приёмкой)
- `enrich.ts` — `fetchProjectClient` (закрытая точка `users?users[]=<owner_id>&reputation=true&employer_reputation=true&jobs=true&status=true&country_details=true&avatar=true`: verification-флаги, рейтинг из `reputation.entire_history`, `registration_date`, `location.country`, скиллы из `jobs[]` → `order.client`; аргумент — `owner_id` из ленты, его нет → client = null + warn), `fetchOrderArtifacts` (вложения проекта через не-compact карточку + страницы по ссылкам из описания: скачивает, HTML чистит до текста, бинарники — плейсхолдер; лимиты 300 KB/файл, 2.5K символов/артефакт, 6K всего → `order.artifacts`), `fetchPortfolio` (портфолио профиля через закрытый `portfolios?limit=12&featured=false&exclude_empty_items=true`, username — из того же закрытого `users?users[]=<id>&status=true`, кэш KV 6 ч). `CRYPTO_SKILL_ID = 2658`. Все закрытые вызовы — через общий `web-auth.ts`
- `parser.ts` — только `normalizeProject` (Freelancer project → `Order`, бюджеты пересчитываются в USD через `currency.exchange_rate`; `owner_id` в карточке анонимно null — его проставляет intake из поля `userId` элемента ленты)
- `service.ts` — D1 dedup (table `seen`: id/source/status/reason/ts, retention 30 days, daily cleanup), `markAlertSeen` — жёсткий гейт до LLM (возвращает `{kept, rejected: {order, reason}[]}`): bids > 15 (`rej:hot-competition`), бюджетные потолки фазы 0 в USD-полях (дно вилки ≤$50 fixed / ≤$15/ч hourly) и мягкий пре-гейт физической возможности ставки `preBidRejectReason` — recruiter (`rej:recruiter`), `is_seller_kyc_required` (`rej:kyc-required`), крипто-скилл 2658 из `jobs` заказчика (ответ `users`, enrich) (`rej:crypto-verified`). Требует enrich ДО вызова; `seenStats24h` для `/status`. При дефиците bids свежие заказы получают ставки первыми: пул скоринга сортируется по `submit_ts` (свежие → старые)
- `bids-balance.ts` — баланс bids. Основной источник: read-only `ajax-api/projects/getBidLimit.php` (веб-авторизация freelancer-auth-v2) — отдаёт `bidsRemaining`, `bidLimit`, `bidRefreshTime`; официальный API баланс не отдаёт. Fallback — леджер D1 (`bid_ledger`, миграция `0002_bid_ledger.sql`): реген 1 bid / 7.5 ч, кап 100. `balance === 0` в тике → idle (опрос и LLM остановлены), заказы не помечаются — курсор стоит, при восстановлении баланса выдача догоняется
- `bidder.ts` — `placeBid`: ставка через закрытый веб-API (`freelancer-auth-v2`, фолбэк OAuth/Bearer): `POST /bids/?compact=true&new_errors=true&new_pools=true`, тело — экспортируемый `buildBidBody` (`milestone_percentage` 50 при 2+ этапах / 100 иначе, `showcases: []`, гвард текста ≥ 100 символов → `bid-text-too-short`); сумма уже в валюте проекта (пересчёта нет); детект ошибки минимального баланса (~$20) по словам balance/deposit/funds/insufficient → reason `insufficient-balance`. Успех → `requestMilestones` (все этапы `score.milestones` сразу, идентификаторы в KV `ms:req:<bidId>`, TTL 60 дней) → `buySealedUpgrade` (корзина платежей, всегда) → `recordBidSpent`. Возвращает `BidResult {placed, bidId?, reason?, sealPurchase?, milestones}`; mode `test`/`off` и отсутствие авторизации/текста — причины отказа, не исключения
- `milestones.ts` — каждый тик (throttle KV `ms:last_check`, 5 мин): детект назначения — `GET /bids/?bidders[]=<мы>` (веб-авторизация, эвристика `isAwarded`: `time_awarded` число или статус со «award»/«accept»; сырые поля логируются `milestones.awarded-bid`) → алерт «🏆 Ставка назначена!», дедуп KV `ms:award:<bid_id>` TTL 60 дней. Создания запросов НЕТ — все этапы уходят со ставкой (bidder.ts). Вместо этого — опрос статусов: для каждой ставки с KV `ms:req:<bid_id>` `GET /milestone_requests/?bids[]=<bid_id>`, при переходе запроса в active/funded/released — алерт «💰 Этап…», статусы обновляются в KV
- `kimi.ts` — LLM scoring, JSON-schema output, retries, validation; кодовый пересчёт value_score в USD; округление ставки до сетки (шаг по величине), пол 70% середины вилки, кап 150%; `sanitizeBidText` — ASCII-only пост-проход текста ставки; `scoreOrder` сам подтягивает bids-баланс в контекст. План этапов (`ScoreResult.milestones`, 2–4 этапа, первый строго 30%, описания 10–250 символов; мелкие < ~$100 и hourly → null) предлагает LLM при скоринге, код пересчитывает суммы от финальной ставки (фолбэк — схема по размеру заказа)
- `prompts.ts` — кодовая обвязка промптов (контракт JSON, value-score механика, апгрейды: `take_upgrades` — только sponsored; sealed покупается кодом всегда и из скоринга не выбирается; семантика полей `order.client`; plaintext-контракт текста ставки; контракт плана этапов — первый 30%, 2–4 этапа, описания 10–250 символов). Правила отбора — только из rules/*.md
- `telegram.ts` — карточки: полная для BID, компактная `formatPassCard` для PASS в test-режиме, `formatRejectCard` для гейта; alerts throttled to 1/hour
- `mode.ts` — `getMode`/`setMode`, KV `mode`, default `test`
- `config.ts` / `types.ts` — typed env config, shared types

Non-secret tunables live in `wrangler.toml` `[vars]` (model, API bases, thresholds, `TARGET_HOURLY`, `BID_MIN_SCORE`). Change them there, not in code.

## Иерархия API Freelancer

> Полный справочник проверенных фактов (эндпоинты, поля, ошибки, квирки) —
> [docs/freelancer-api.md](docs/freelancer-api.md). Дальше — только иерархия.

- **Приоритет 1 — открытые (публичные, без авторизации) точки API** (достаточно User-Agent обычного браузера):
  - `projects/0.1/projects/active` — выдача новых проектов (основной канал);
  - `projects/0.1/projects/seo` — данные заказчика по seo_url: verification (payment_verified, deposit_made и т.д.), рейтинг работодателя, `other_employer_jobs` (проверено 04.10.2026);
  - `users/0.1/users/{id}` — reputation/employer_reputation; `payment_verified` анонимно не отдаёт.
- **Приоритет 2 — закрытые точки официального Develop API.** Авторизация работает заголовком `Authorization: Bearer <FL_API_KEY>` (и `Freelancer-OAuth-V1`; проверено 04.10.2026). Ключ хранится в секретах (`FL_API_KEY`), не в коде и не в логах. **Ставки через Bearer/OAuth реальной постановкой не подтверждены** — рабочий путь ставок перенесён в закрытый веб-API (см. ниже).
  - `projects/0.1/milestone_requests/` (чтение/отмена) — см. раздел «Этапные платежи» в docs/freelancer-api.md.
  - `projects/0.1/milestones/` — создание (`POST {project_id, bidder_id, amount, reason, description}`), release (`PUT /milestones/{id}/` с `action=release` / `request_release`), отмена (`DELETE`).
  - **`PUT /projects/0.1/bids/{bid_id}/` body JSON `{action}`** — действия над ставкой (проверено 05.10.2026). Действующий enum: `seal | sponsor | highlight | retract | revoke | accept | award`. **Заменён корзиной платежей:** `action=seal` → 400 `USER_NOT_IN_PFP` (API-покупка sealed требует PFP, хотя веб-форма предлагает sealed за $0.10) — автопокупка sealed живёт в `payments.ts` (корзина, веб-авторизация).
    - `action=sponsor` требует `amount`; семантика суммы НЕ ясна (amount=2 → «Bid cannot be less than 600» — похоже на минимум $6 или минимум в единицах ставки). **Автопокупка sponsored не включена** — пока Gleb не проверит вручную на сайте, что реально списывается.
    - Цены апгрейдов **динамические per project**: sealed стабильно $0.10; sponsored на ₹7000 (~$84) — $1.90, на $500 — $2.90 (официальные «0.75%, min $1.90/$5, max $20» недостоверны). Точная цена известна только форме ставки. Слот sponsored **один на проект, без аукциона** — кто купил первым, тот в топе, позиция не деградирует с ростом числа ставок.
- **Закрытый веб-API (внутренние точки веб-приложения), авторизация `freelancer-auth-v2`** — основной источник enrich и первый канал intake (второй — публичный поиск `projects/active`, см. «Проекты») (исследование Gleb 07.10.2026: всё работает без кук, только с заголовком; горячая замена через KV `fl:auth`, эндпоинт `/admin/fl-auth`; детект протухания — HTTP 401 или `error.code === "UNAUTHORIZED"`):
  - `ajax-api/navigation/project-feed/pre-populated.php?jobIds[]=<скиллы>&fromWebapp=true&compact=true` — лента новых заказов (10 элементов, курсор по `time`);
  - `projects/0.1/projects?projects[]=<id>&full_description=true&upgrade_details=true&job_details=true&owner_info=true&attachment_details=true` — карточка по id (отличие от публичной: `active_prepaid_milestone` лежит внутри `upgrades`);
  - `users/0.1/users?users[]=<id>&reputation=true&employer_reputation=true&jobs=true&status=true&country_details=true&avatar=true` — данные заказчика (verification, рейтинг, скиллы);
  - `users/0.1/portfolios/?limit=12&users[]=<id>&featured=false&exclude_empty_items=true` — портфолио;
  - `ajax-api/projects/getBidLimit.php` — баланс bids (bids-balance.ts).
  - **Ставки и этапы (проверено живой ставкой 09.10.2026, bid 496321109):**
    - `POST projects/0.1/bids/?compact=true&new_errors=true&new_pools=true` — размещение ставки (bidder.ts, `buildBidBody`);
    - `POST projects/0.1/milestone_requests/?webapp=1&compact=true…` — этапные запросы, все сразу после ставки; чтение `GET …/milestone_requests/?bids[]=<bid_id>`;
    - корзина платежей `payments/0.1/carts/` — покупка Sealed ($0.10) всегда кодом (payments.ts): корзина → позиция → process (списание на третьем шаге).
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

- **Цена ставки — детерминированное правило фазы 0** (fixed и hourly): ВСЕГДА низ вилки, без исключений; `bid_avg` не используется. Стратегия: бидимся на всё, на что фрилансеры с отзывами не пойдут. Снеп круглой сетки; платформа сама не даёт ниже низа вилки. Предложение LLM по сумме игнорируется. Низкий value_score — ожидаемое следствие низкой цены, не основание для PASS.
- **BID_MIN_SCORE = 10** (`wrangler.toml`) — порог под стратегию первых отзывов.
- **Weekly limit (hourly):** final `weekly_limit_hours = min(LLM value or DEFAULT_WEEKLY_LIMIT, DEFAULT_WEEKLY_LIMIT, 40)` (`clampWeeklyLimit`). LLM may lower it for a tight deadline, never raise it.
- **Fee/net:** fixed — 10% с минимумом $5; hourly — плоско 10%, без минимума.
- **Budget gates фазы 0 — в коде, до LLM** (`markAlertSeen`): больше 15 откликов → отклонить; дно вилки ≤$50 (fixed) / ≤$15/ч (hourly) в USD-пересчёте, иначе отклонить. «Срочность/кривизна ТЗ» — мягкий плюс в скоринге LLM, не гейт (правила — в rules/freelancer-правила-отбора.md).
- **Этапы (fixed):** план (2–4 этапа, первый строго 30%) предлагает LLM при скоринге (`score.milestones`), суммы пересчитывает код от финальной ставки; в теле ставки `milestone_percentage` = 50 (константа фронта при 2+ этапах) / 100; ВСЕ этапные запросы (`milestone_requests`) уходят сразу со ставкой (bidder.ts), статусы опрашивает milestones.ts. Sealed покупается всегда кодом через корзину платежей. Релиз — только по факту готовности (ранний релиз + жалоба = штраф ранга).

Note: platform-specific selection rules live in `rules/freelancer-*.md`. The pipeline is platform-shaped (parser per platform, shared dedup/scoring/card layers) — при появлении второй площадки её правила добавляются как отдельный файл rules/, без переломки общего конвейера.

## Testing

Offline acceptance (no network, no secrets — чистая логика с моками fetch/KV):

```bash
npm run acceptance   # 257 проверок: скоринг-математика, сетка округления, валюты,
                     # fee, пол/кап, санитайзер, isAwarded, парсинг ленты
                     # (parseFeedBody/mapFeedItem), карточки (mapCardToProject,
                     # shim prepaid milestone), заказчика (mapUsersResponse,
                     # fetchProjectClient по owner_id), портфолио,
                     # карточки (лимит 4096), потолок апгрейдов
```

Test endpoints (all require header `X-Admin-Token`, except the webhook path):

```
GET  /test/kimi-models   — verify Kimi API key and model name
POST /test/score         — score a given order JSON end-to-end (пустое тело — свежий заказ из active)
POST /test/tick          — run one full pipeline tick manually
POST /test/milestones    — детект назначения + опрос статусов этапов; dry-run по умолчанию, {"dryRun": false} — реальные алерты
GET  /test/logs          — кольцевой лог
GET  /test/bids-balance  — баланс bids
POST /test/set-webhook   — регистрация webhook Telegram (один раз)
```

Before enabling/enlarging `[triggers] crons`, run the tick test and confirm cards arrive in Telegram. After changing `wrangler.toml` bindings, run `wrangler types` and `npm run typecheck`.

## Локальные прогоны — ЗАПРЕЩЕНЫ

Правило 7 (решение Gleb'а, 09.10.2026): никаких `wrangler dev`, локальных тиков, эмуляторов с прод-данными. Локально — только оффлайн-проверки чистой логики (`typecheck`, `acceptance`). Любая проверка работы системы — на выкачанном через CI воркере.

- **Чтение/запись KV из CLI — ТОЛЬКО с `--remote`.** Без флага `wrangler kv key get/put/delete` работает с локальным эмулятором (`.wrangler/`), где лежит устаревший мусор прошлых сессий — инцидент 09.10.2026: по таким «данным» был «диагностирован» несуществующий сбой прода (застывшие курсоры, «mode=test»). Проверка состояния прода: `npx wrangler kv key get mode --namespace-id b629829e784842d3a9c78f612f689974 --remote` (namespace id — из `wrangler.toml`).
- `wrangler d1 query` на Windows падает с внутренней ошибкой (`UV_HANDLE_CLOSING`) — вместо него D1 читать через Cloudflare MCP (d1_database_query, database_id из `wrangler.toml`).
- Временный файл приёмки исторически лежал в `tmp/` (в gitignore) — стенд живёт в `scripts/acceptance.ts`.

## Operational notes

- **Тариф аккаунта: Workers Paid ($5/мес)** (Gleb, 09.10.2026). Квоты KV на нём: запись/чтение/удаление — фактически без жёсткого дневного потолка (включено 1M записей и 10M чтений в месяц, сверх — $5/млн записей; ~3–4k записей/сутки от heartbeat/ring ≈ 10% включённого объёма, переплат нет), хранилище 1 ГБ. D1 на платном тарифе — без дневных лимитов строк. Устаревшая забота «1000 put/сутки» больше не ограничивает, но лишние записи всё равно не добавляем. Всё равно в силе: ring log буферизуется и флашится раз за тик, seen-дедуп в D1, KV-записей немного.
- **Чтение прода — только с `--remote` и через MCP** (см. раздел выше про локальный эмулятор).
- **D1 limits:** max 100 bound parameters per query — dedup batches accordingly (SELECT by ≤100 id, INSERT ≤20 rows). Remote migration applied via `wrangler d1 migrations apply freelancer-monitor --remote`.
- First deploy of a fresh clone: create KV namespace, set the secrets, run the tests above, then enable crons.
- The deployed worker already holds its secrets; CI `wrangler deploy` does not touch them.
- Alerts are rate-limited on purpose (1/hour) — don't bypass the limit when changing `telegram.ts`. Card sending is intentionally unlimited.
- `live`-режим требует веб-авторизации (`FL_USER_ID` + `FL_AUTH_HASH`, горячая замена через KV `fl:auth`); фолбэк — `FL_OAUTH_TOKEN` или `FL_API_KEY` (тогда Sealed не покупается: `sealPurchase: "no-web-auth"`, карточка честно сообщает). Без авторизации `placeBid` возвращает reason (`oauth-missing` / `fl-user-id-missing`), карточка придёт с «⚠️ Отклик НЕ отправлен». Ошибка «минимальный баланс ~$20» детектится по тексту ответа и уходит отдельным алертом.

## Production state (2026-10-09)

- **Live-ставка через веб-API подтверждена 09.10.2026:** bid 496321109 на проект
  40758567, этапы 3000/4000 INR ушли сразу со ставкой, Sealed куплен за $0.10
  через корзину платежей. Ставки идут заголовком `freelancer-auth-v2`
  (KV `fl:auth`), OAuth/Bearer — фолбэк.

- **Режим: `live`.** Переключение: Telegram `/mode ...` или
  `npx wrangler kv key put mode live --namespace-id b629829e784842d3a9c78f612f689974`
  (namespace id — из `wrangler.toml`). Перед переводом в live — полный цикл приёмки (см. ниже).
- Воркер: `https://freelancer-monitor.ksenia.workers.dev` (поддомен аккаунта — `ksenia`).
  Health-check: `curl` на корень → **ожидаем HTTP 404** (это «жив»; 000/5xx — проблема).
- Аккаунт фрилансера: `gleb7499` (id 94242579). Секреты в проде (7): ADMIN_TOKEN,
  FL_AUTH_HASH, FL_USER_ID, KIMI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, FL_API_KEY.
  `FL_OAUTH_TOKEN` отсутствует — ставки/этапы/Sealed идут через веб-авторизацию
  (freelancer-auth-v2), Bearer-ключ — фолбэк.
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
  DELETE-метод — 405. С 09.10.2026 все этапные запросы уходят сразу со ставкой
  (bidder.ts), чтение статусов — `GET /milestone_requests/?bids[]=<bid_id>`.
- Размещение ставки через закрытый веб-API подтверждено живой ставкой 09.10.2026
  (bid 496321109, проект 40758567): `POST /bids/?compact=true&new_errors=true&
  new_pools=true` с заголовком `freelancer-auth-v2`, `milestone_percentage` 50,
  этапы 3000/4000 INR, Sealed куплен за $0.10 через корзину платежей. Путь
  ставок через Bearer/OAuth реальной постановкой не подтверждён.
- `GET /users/0.1/portfolios/?users[]=<id>` (Bearer) — элементы портфолио: `title`,
  `description` (внутри живут демо-ссылки), `files`. Профиль: `https://www.freelancer.com/u/<username>`
  (username анонимно отдаёт `users/0.1/users/{id}?compact=true`).
- Часть заказов требует минимальный баланс ~$20 на счёту для ставки — текст ошибки ловим
  по словам balance/deposit/funds/insufficient (реальный текст ещё не видели).
- **Cryptocurrency-проекты требуют верификации аккаунта (Freelancer Verified)** — иначе
  POST bids → 403 `RESTRICTED_FROM_BIDDING_PREMIUM_VERIFIED_JOB` (проверено 04.10.2026).
  Детектятся скиллом 2658 в `jobs` заказчика (закрытый ответ `users`, enrich) → пре-гейт `rej:crypto-verified` до LLM.
- **Recruiter/pf_only-проекты — только для Preferred Freelancer.** Флаги `upgrades.recruiter`
  / `pf_only` в API анонимизированы (показывают null/false даже с Bearer на заведомо
  закрытом проекте; сайт показывает предупреждения только залогиненным) — **пре-гейт
  невозможен**, ловим на POST: 403 → reason с текстом ошибки. Оба ограничения нередко
  стоят на одном проекте.
- **Лимит текста ставки ~1500 символов** — сверху сайт не даёт редактировать, хотя API
  принимает длиннее. Генератор обязан укладываться (см. правила отклика).
- **Ранжирование откликов** (официальный гайд Freelancer, freelancer.cn/community):
  ранг персонализирован под работодателя, вид фрилансера ≠ вид работодателя. Факторы:
  отзывы (свежесть экспоненциальна, число, размер проектов нелинейно, вес ревьюера),
  milestone-платежи (оборот + частота релизов), отзывчивость (accept rate, скорость
  ответа, штрафы за спам/офсайт), профиль (экзамены, полнота). Ранняя ставка помогает,
  но не компенсирует нулевую историю — новый аккаунт без отзывов тонет внизу по мере
  набора откликов. Экзамены — самый дешёвый буст для нового аккаунта; sponsored-ставка
  гарантированно в топе списка.
- `projects/seo` `result.client`: `verification{payment_verified, deposit_made, email_verified,
  phone_verified, profile_complete}`, `rating{average, review_count}`, `registration_unixtime`,
  `address`; `other_employer_jobs` — примерный список открытых заказов клиента.

## Продуктовые решения (контекст, почему код устроен так)

- Ставка — **всегда низ вилки** (без исключений, `bid_avg` не используется):
  заказы видны системой через секунды после публикации, стратегия фазы 0 —
  бидимся на всё, на что фрилансеры с отзывами не пойдут.
- Скидка за новизну аккаунта — только цифрой и только вместе с блоком «новый профиль»;
  иначе новизну не упоминать. Портфолио-ссылка убедительнее акцента на новизне.
- `order.client` полностью в null → LLM взвешивает риск сама (авто-BID/авто-PASS запрещены).
- Этапность: стартовый этап всегда 30% (жёсткое правило скоринга), полный план
  (2–4 этапа с описаниями) предлагает LLM при скоринге, суммы пересчитывает код
  от финальной ставки; все этапные запросы уходят сразу со ставкой (bidder.ts),
  статусы опрашивает milestones.ts.
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
