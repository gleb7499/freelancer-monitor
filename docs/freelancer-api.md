# Freelancer API — справочник по проверенным фактам

> Собрано из живых проб 04–07.10.2026. Всё ниже — проверено запросами, если не
> сказано иное. «Не проверено» — значит источник официальная документация/SDK,
> живой пробы не было. Источник истины по иерархии доступа — AGENT.md
> (раздел «Иерархия API Freelancer»).

## Авторизация

| Контекст | Схема | Что работает |
| --- | --- | --- |
| Открытые точки | Только `User-Agent` браузера (без UA часть CDN режет) | `projects/active`, `projects/?projects[]`, `projects/seo`, `users/{id}` (репутация) |
| Develop API (закрытые точки) | `Authorization: Bearer <FL_API_KEY>` (тот же ключ работает и как `Freelancer-OAuth-V1`) | `bids` GET/POST, `PUT bids/{id}/`, `milestone_requests`, `milestones`, `portfolios` |
| OAuth аккаунта | `Freelancer-OAuth-V1: <FL_OAUTH_TOKEN>` (предпочтителен, когда задан) | то же; в проде секрета нет, рабочая схема — Bearer-ключ |
| Пользовательский OAuth1-токен | тот же заголовок `Freelancer-OAuth-V1: <user token>` | то же (проверено 07.10.2026, аккаунт gleb7499 / 94242579); анонимизацию флагов/owner_id НЕ снимает |
| Веб-авторизация | заголовок `freelancer-auth-v2: <FL_USER_ID>;<FL_AUTH_HASH>` + `freelancer-app-name: main`, `freelancer-app-platform: web`; горячая замена через KV `fl:auth` (эндпоинт `/admin/fl-auth`) | `ajax-api/projects/getBidLimit.php` (баланс bids), **лента** `ajax-api/navigation/project-feed/pre-populated.php`, **карточка** `projects/0.1/projects?projects[]=`, **заказчик** `users/0.1/users?users[]=`, **портфолио** `users/0.1/portfolios/` (всё без кук, проверено 07.10.2026); **ставки** `POST projects/0.1/bids/`, **этапные запросы** `milestone_requests`, **корзина платежей** `payments/0.1/carts/` (проверено живой ставкой 09.10.2026, bid 496321109 — см. разделы «Ставки» и «Этапные платежи») |

Секреты: `FL_API_KEY` — прод-секрет и `--var` для локального `wrangler dev`
(в `.dev.vars` локально OAuth-токена нет — Bearer-ключ единственный путь).
Ключ Develop API действует от лица аккаунта (владелец ключа = пользователь).

## Закрытый веб-API (freelancer-auth-v2) — intake и enrich

> Исследование Gleb 07.10.2026: все точки ниже работают **без кук**, только с
> заголовком `freelancer-auth-v2: <userId>;<hash>` (+ `freelancer-app-name:
> main`, `freelancer-app-platform: web`, `accept: application/json`, браузерный
> User-Agent). Протухание авторизации: HTTP 401 или тело
> `{error:{code:"UNAUTHORIZED"}}`. С 08.10.2026 это основной закрытый канал
> мониторинга и обогащения (наряду с открытым поиском `projects/active`, см.
> раздел «Проекты» ниже — оставлен как справка по открытым точкам).

### `GET /ajax-api/navigation/project-feed/pre-populated.php` — лента новых заказов

Параметры: `jobIds[]=<11 скиллов>&fromWebapp=true&compact=true&new_errors=true&new_pools=true`.
Конверт: `{status:"success", isValidAgainstSchema:true, result:[элемент×10]}`.
Поля элемента: `id, type("project"|"contest"), userId (owner_id!), time (unix
sec), submitDate ("YYYY-MM-DD HH:MM:SS"), title, text, userName, jobString,
linkUrl, minbudget, maxbudget, currency (символ), currencyCode, exchangerate,
projIsHourly, urgent, featured, fulltime, nda, hidebids, recruiter, listed,
imgUrl, nonpublic, free_bid_until`. Конкурсы (`type:"contest"`) пропускаем.
Окно выдачи ~2.5 ч (10 элементов) — при 30-с тиках пропусков нет; курсор по
`time`, bootstrap now-300 с.

### `GET /api/projects/0.1/projects?projects[]=<id>` — карточка по id (дозаполнение)

Параметры: `full_description=true&upgrade_details=true&job_details=true&
owner_info=true&attachment_details=true&webapp=1&compact=true&new_errors=true&
new_pools=true`. Конверт: `{status:"success", result:{projects:[{…41 поле…}]}}`.
Поля совместимы с интерфейсом `FreelancerProject` (parser.ts). **Отличие от
публичной точки:** `active_prepaid_milestone` лежит ВНУТРИ `upgrades` —
`mapCardToProject` поднимает его в верхний уровень (`normalizeProject` ждёт
его там). Отдельный запрос с `owners[]=<owner_id>&limit=10` отдаёт другие
заказы заказчика.

### `GET /api/users/0.1/users?users[]=<owner_id>` — данные заказчика

Параметры: `reputation=true&employer_reputation=true&jobs=true&status=true&
country_details=true&avatar=true&webapp=1&compact=true&new_errors=true&
new_pools=true`. Конверт: `result.users["<id>"]`:
- `status` — verification-флаги (`payment_verified, email_verified,
  deposit_made, identity_verified, phone_verified, …`);
- `reputation.entire_history` — рейтинг и число отзывов (имена полей
  защищённо проверяем несколькими вариантами);
- `jobs[{id,name,category}]` — скиллы заказчика (здесь крипто-скилл 2658);
- `registration_date` — unix или строка, оба принимаются;
- `location{country,…}`.

Тот же URL с `usernames[]=<name>` ищет по имени; `users[]=<id>` с
`status=true` отдаёт и `username` (используется для ссылок на портфолио).

### `GET /api/users/0.1/portfolios/` — портфолио ( enrich )

Параметры: `limit=12&users[]=<my_id>&featured=false&exclude_empty_items=true&
webapp=1&compact=true&new_errors=true&new_pools=true` →
`result.portfolios[<id>]`.

## Ставки, этапы и корзина через веб-API (проверено живой ставкой 09.10.2026)

> Эксперимент Gleb'а 09.10.2026: реальная live-ставка bid **496321109** на проект
> **40758567** (этапы 3000/4000 INR). Всё ниже работает с заголовком
> `freelancer-auth-v2` **без кук и без XSRF** — только заголовок. Это основной
> путь постановки ставок (bidder.ts); Develop API (Bearer/OAuth) реальной
> постановкой не подтверждён.

### `POST /api/projects/0.1/bids/?compact=true&new_errors=true&new_pools=true` — размещение ставки

Тело: `{project_id, bidder_id, amount, period, milestone_percentage,
description, showcases: []}`. `amount` — в валюте проекта.
`milestone_percentage` — **константа фронта**: 50 при 2+ этапах / 100 иначе
(не доля первого этапа — фронт шлёт 50 всегда, когда этапов больше одного).
`description` короче 100 символов → HTTP 500 (гвард в коде:
`bid-text-too-short`). Ответ: `{result:{id}}` — id ставки.

### `POST /api/projects/0.1/milestone_requests/?webapp=1&compact=true&new_errors=true&new_pools=true` — этапные запросы

Тело: `{project_id, bid_id, description, amount}` — по одному запросу на каждый
этап плана (2–4 шт.), сумма этапов ≤ сумме ставки. Все запросы уходят **сразу
после ставки** (bidder.ts), идентификаторы хранятся в KV `ms:req:<bidId>`.
Чтение: `GET …/milestone_requests/?bids[]=<bid_id>` — элементы с полями
`id, bid_id, amount, status, is_initial_payment, …` (конверт словарь или
список). Запрос создаётся **даже без назначения** (status pending).

### Корзина платежей — покупка Sealed ($0.10)

База отдельная: `https://www.freelancer.com/api/payments/0.1`. Три шага
(payments.ts, `buySealedUpgrade`):

1. `POST /carts/` — создать корзину;
2. `POST /carts/{id}/cart_items/` — позиция `{context_type:"bid_upgrade",
   context_sub_type:3, currency:1, amount:0.1, …}`;
3. `PUT /carts/{id}` `{action:"process"}` — **списание на третьем шаге**.

Константы: `currency` USD = 1 (живой ответ `GET projects/0.1/currencies`,
id=1); `context_sub_type` из enum JS-бандла фронта: sponsored=1, highlight=2,
sealed=3. Работает ТОЛЬКО с веб-авторизацией (OAuth/Bearer не принимаются);
при OAuth-фолбэке ставки Sealed не покупается. Повторная покупка купленного
sealed — бесплатный no-op.

## Проекты

### `GET /api/projects/0.1/projects/active` — второй intake-канал (открытая)

> С 08.10.2026 — второй канал мониторинга (вместе с лентой закрытого веб-API,
> см. выше). Точка публичная: без `freelancer-auth-v2` и без кук отдаёт 200 и
> полный JSON (тот запрос, что делает страница поиска фронта; исследование
> Gleb 08.10.2026). Заголовки — только браузерный User-Agent.

Параметры (как у фронта): `limit=20&full_description=true&job_details=true&
upgrade_details=true&owner_info=true&jobs[]=<11 скиллов>&languages[]=en&
project_types[]=hourly&project_types[]=fixed&sort_field=submitdate&webapp=1&
compact=true&new_errors=true&new_pools=true`.

Конверт: `{status:"success", result:{projects:[…], total_count}}`, сортировка
`submitdate` DESC (свежие первые). Элементы — ПОЛНЫЕ карточки (37 полей:
`id,title,seo_url,currency,description,submitdate,type(fixed|hourly),bidperiod,
budget{minimum,maximum},bid_stats{bid_count,bid_avg},upgrades,language,location,
is_seller_kyc_required,owner_info{…},time_free_bids_expire,…`) — дозаполнение
по id не нужно. `owner_id` берём из `owner_info.id ?? user_id ?? owner_id`
(анонимный `owner_id` карточки по-прежнему null).

Курсор по `submitdate` (unix sec, строго `>`), bootstrap now-300 с, throttle
10 с — по образцу ленты (KV `search:last_submit`/`search:last_fetch`).

### Анонимизация и ограничения (важно)

- `owner_id` в любых проектных ответах анонимно **null** — и с пользовательским
  OAuth1-токеном тоже (проверено 07.10.2026).
- Флаги ограничений (`upgrades.recruiter`, `pf_only`, `qualified`) приходят
  **заниженными** (`null`/`false`) с Bearer-ключом И с OAuth-токеном аккаунта
  на заведомо закрытом проекте. Сайт показывает предупреждения («Preferred
  Freelancer only», «Verified for Cryptocurrency») **только залогиненной
  веб-сессии** — данных для пре-гейта нет, ловим на POST.
- Цены апгрейдов проекта через API не получить: `?upgrade_prices=true`
  принимается без ошибки, но полей не добавляет; `projects/{id}/upgrades/` и
  `projects/0.1/upgrade_prices/` → 404 (пробы 07.10.2026).
- Крипто-проекты детектируются скиллом **2658 (Cryptocurrency)** из ответа
  `projects/seo` (в intake скиллов нет).

### `GET /api/projects/0.1/projects/?projects[]=<id>` (открытая, не-compact)

Полный набор полей: `attachments, files, drive_files` (у большинства null),
`nda_details, requires_upfront_funding, qualifications, …`. `jobs` — null.

### `GET /api/projects/0.1/projects/seo?seo_url=<slug>&webapp=1&compact=true` (открытая)

> **Заменена (08.10.2026):** данные заказчика теперь берутся из закрытой точки
> `users/0.1/users?users[]=<owner_id>` (см. выше). Оставлено как справка.

`seo_url` — полный slug с категорией: `mongodb/Urgent-Express-Web-App-Support`.
Голый slug без категории → `GAF_EXCEPTION` «resource does not exist»
(проверено 07.10.2026).

Основной источник данных о заказчике. Ответ `result`:
- `client`: `verification{payment_verified, deposit_made, email_verified,
  phone_verified, profile_complete}`, `rating{average, review_count}`,
  `registration_unixtime`, `address{city,country,country_code}`;
- `other_employer_jobs` — массив других открытых заказов (длина ≈ число
  открытых проектов);
- `skills: [{id,name}]` — скиллы проекта (здесь живёт крипто-скилл 2658);
- `bids` — открытые ставки с рейтингами/странами конкурентов;
- `bid_stats{bid_count, bid_avg}`.

Не отдаёт: флаги ограничений, цены апгрейдов.

## Ставки (bids)

> **Основной путь — веб-API** (см. раздел «Ставки, этапы и корзина через
> веб-API» выше): живой ставкой 09.10.2026 подтверждены `POST bids/` и корзина
> платежей. Раздел ниже — справка по Develop API (Bearer/OAuth); реальной
> постановкой ставки через него не подтверждён.

### `POST /api/projects/0.1/bids/` (закрытая, Develop API)

Body JSON: `{project_id, bidder_id, description, amount, period,
milestone_percentage}`. `amount` — в валюте проекта; `milestone_percentage` —
доля ПЕРВОГО этапа (в веб-пути фронт шлёт константу 50 при 2+ этапах / 100).

**Полный список полей публичного API** (источники: официальный Python-SDK
`place_project_bid` и современный Go-SDK `CreateBidBody`, 07.10.2026):
`project_id, bidder_id, amount, period, milestone_percentage, description,
profile_id`. Обновление ставки (`PUT bids/{id}/` без action): `amount,
milestone_percentage, description` (`UpdateBidBody`).

**Чего в публичном API НЕТ** (проверено по SDK + живые пробы 07.10.2026):
- графика этапов с суммами (веб-форма отклика умеет «Request milestone
  payments» с произвольными строками описание+сумма — это внутренний
  веб-эндпоинт, не публичный API; строки должны суммироваться в сумму ставки);
- покупки апгрейдов в момент отклика (чекбоксы Sponsored/Sealed/Highlight на
  форме — тот же внутренний путь; публично покупка только отдельным
  `PUT bids/{id}/` после размещения);
- видео-ставки.

Авторизация Bearer-ключом проверена косвенно: фейковый `project_id=0` → 500
(валидация), а не 401.

Таксономия ошибок (текст ответа всегда JSON с `message`/`error_code`):

| Ситуация | HTTP / код | Детект в коде |
| --- | --- | --- |
| Нет авторизации | 401 `NOT_AUTHENTICATED` | status 401 |
| Крипто-проект без верификации | 403 `RESTRICTED_FROM_BIDDING_PREMIUM_VERIFIED_JOB` | 403 + «verified/verification/restricted» |
| Preferred-only проект | 403 «You must be a Preferred Freelancer…» | то же |
| Мин. баланс ~$20 | текст с «balance/deposit/funds/insufficient» (реальный текст не видели) | слова |
| Калифорнийский проект без привязки Escrow.com | 403 «linked Escrow.com account» | слова «escrow» |
| Ставка ниже дна вилки | `BID_AMOUNT_INVALID` (платформа не даёт; Gleb проверил вручную) | sanity до POST |
| Уже ставили | текст содержит «already» | слово |

### `GET /api/projects/0.1/bids/?bidders[]=<our id>` (закрытая)

Наши ставки. Ключевые поля: `id, project_id, amount, retracted,
milestone_percentage, sealed, sponsored, highlighted, award_status,
frontend_bid_status, time_awarded, time_accepted, complete_status, paid_status,
bid_rank, new_bid_rank` (ранги для нас null — видимо, только для работодателя).

Детект назначения исполнителем (эвристика, не подтверждена живым назначением):
`time_awarded` — число, либо строка `award_status`/`frontend_bid_status` со
«award»/«accept». Сырые значения логируются (`milestones.awarded-bid`).

### `GET /api/projects/0.1/bids/?projects[]=<id>` (закрытая) — ставки конкурентов

Работает с Bearer и с пользовательским OAuth (проверено 07.10.2026).
Выдаёт до ~100 ставок проекта с полями `bidder_id, amount, sealed, sponsored,
highlighted, time_submitted` — флаги ПОКУПОК видны, в отличие от флагов
ограничений проекта. Применение: проверка, свободен ли слот sponsored
(слот один на проект), разведка конкуренции (доля sealed, медиана ставок).
Живые наблюдения 07.10.2026: на проекте с 137 ставками sealed купили 30,
sponsored/highlighted — 0; `bid_count` в `bid_stats` актуальнее карточек
монитора (они снимаются на момент intake).

### `GET /api/projects/0.1/projects/{id}/bids` (закрытая) — вариант списка ставок

Тоже работает с OAuth (07.10.2026); отдаёт `bid_rank` по каждой ставке
(1, 2, 3…; у sealed-ставок `amount` скрыт — 0.0). Порядок для фрилансера —
по дате (официально), ранговая сортировка видна работодателю; `bid_rank` даёт
приблизительное представление о позиции. `GET …/projects/{id}/bids_info`
(«информация для размещения ставки» из SDK) → 404: не существует или
закрыто работодателю.

### `PUT /api/projects/0.1/bids/{bid_id}/` (закрытая) — действия над ставкой

Body **строго JSON** (`Content-Type: application/json`): `{"action": "…"}`.
Form-urlencoded парсит action, но НЕ парсит `amount`; параметры в query → 405.

Действующий enum `BidAction` (перебором на ставке-заглушке): `seal, sponsor,
highlight, retract, revoke, accept, award`. `reject` — недопустимое значение.

- `action=seal` → 400 `USER_NOT_IN_PFP` («You are not in the Preferred
  Freelancer Program») — API-покупка sealed требует PFP, хотя веб-форма
  предлагает sealed за $0.10. **Путь заменён корзиной платежей** (веб-API,
  проверено живой покупкой 09.10.2026 — см. выше); автопокупка sealed живёт в
  `payments.ts` и работает всегда, без PFP.
- `action=sponsor` требует дополнительно `amount`; семантика суммы НЕ ясна
  (`amount=2` → «Bid cannot be less than 600»). Автопокупка sponsored
  **отключена** до ручной проверки Gleb'ом на сайте.
- Покупка апгрейдов через веб (что реально спишется) — не проверено.

## Этапные платежи (milestones)

### Жизненный цикл (официальная документация)

Requested (запрос создания; клиент принимает/отклоняет) → Funded (деньги
списаны у клиента и заморожены) → Release Requested → Released (зачисление,
1–3 дня клиринга) / Cancelled / Disputed.

Правила: просить funding ДО начала работы; просить release только по факту
готовности этапа (ранний релиз + жалоба клиента = штраф ранга); в ранг идут
выпущенные суммы и частота; **отзыв возможен только при полной оплате через
milestone-систему**. Ограничения «заказ дешевле X — этапы недоступны» в
документации нет; практический пол — комиссия 10% мин. $5 с проекта.

### Эндпоинты (проверены)

- **Основной путь — веб-API** (см. раздел выше): `POST
  /projects/0.1/milestone_requests/?webapp=1&compact=true…` — все этапы сразу
  после ставки; чтение `GET …/milestone_requests/?bids[]=<bid_id>`.
- Develop API: `POST /projects/0.1/milestone_requests/` `{project_id, bid_id,
  amount, description}` — создаёт запрос **даже до назначения** (status pending).
- `GET /projects/0.1/milestone_requests/?users[]=<id>` и
  `?milestone_requests[]=<id>` — список/карточка запроса с `status`.
- Отмена запроса: `PUT /projects/0.1/milestone_requests/{id}/` body
  `{"action":"delete"}` (метод DELETE → 405).
- `POST /projects/0.1/milestones/` — создание этапа работодателем;
  `PUT /milestones/{id}/` с `action=release` / `request_release` (из SDK,
  живьём не пробовали).

## Портфолио и профиль

- `GET /api/users/0.1/portfolios/?users[]=<id>` — только с Bearer (анонимно
  404). Элементы: `id, title, description` (в конце описаний — ссылки на живые
  демо на GitHub Pages), `files`.
- URL элемента портфолио: `https://www.freelancer.com/u/<username>/portfolio-item/<id>`
  (проверено: 200, компонент portfolio-item-card; формат `/portfolio/<id>` не
  подтверждён как канонический).
- `GET /api/users/0.1/users/{id}?compact=true` — анонимно отдаёт `username`
  (для сборки ссылок на портфолио).
- `GET /api/users/0.1/users/{id}?reputation=true&employer_reputation=true` —
  репутация фрилансера/работодателя; `status.payment_verified` анонимно не
  отдаёт (схема поля есть, значение доступно только с полномочиями сессии).

## Баланс bids

`GET https://www.freelancer.com/ajax-api/projects/getBidLimit.php?userId=<id>&compact=true`
с веб-авторизацией (см. выше) → `result{bidsRemaining, bidLimit,
bidRefreshTime (сек до регена)}`. Официальный API баланс не отдаёт
(проверено: users/self и SDK). Fallback — леджер D1 (`bid_ledger`).

`GET /api/users/0.1/self/` с OAuth: поля `preferred_freelancer,
account_balances, membership_package, badges` есть в схеме ответа, но приходят
`null` при любых параметрах (`full`/`webapp`/`membership&balances`) — PFP-статус
и баланс через OAuth1 не читаются, только веб-сессия (`freelancer-auth-v2`).
Практический детект PFP: попытка `action=seal` → `USER_NOT_IN_PFP`
(проверено 07.10.2026).

## Апгрейды ставок

| Апгрейд | Цена | Механика |
| --- | --- | --- |
| sealed | стабильно $0.10 | **покупается кодом всегда** через корзину платежей веб-API (проверено живой покупкой 09.10.2026; повторная покупка купленного — бесплатный no-op); путь `PUT bids action=seal` требует PFP и заменён |
| sponsored | **динамическая per project** (наблюдения: $1.90 на ставке ₹7000 ≈ $84; $2.90 на $500; официальные «0.75%, min $1.90/$5, max $20» недостоверны) | слот **один на проект**, первый купивший занимает; аукциона нет, позиция не деградирует; покупка доступна и после ставки («Sponsor My Bid»); API-покупка: PUT `action=sponsor` + `amount` (семантика суммы не ясна) |
| highlight | динамическая ($0.30 наблюдение; официально «$1.00» — недостоверно) | **не используем** (решение Gleb'а) |
| Expert Guarantee | возвратный депозит от $2 / 2% ставки | ручной режим; официально: возврат после завершения проекта |

## Лимиты и квирки платформы

- Текст ставки: **≤1500 символов** (длиннее сайт не даёт редактировать; API
  принимает — поэтому кап enforced кодом).
- Часть заказов требует минимальный баланс ~$20 на счёту.
- Калифорнийские проекты (резидентство клиента) требуют привязанный Escrow.com
  и веб-согласия с условиями (покрытие согласия на будущие API-ставки —
  эксперимент Gleb'а, не завершён).
- Комиссия: fixed 10% (мин. $5), hourly 10%.
- Скорость рынка: дешёвый срочный заказ (€8–30) собрал 38 ставок и закрылся
  с назначением исполнителя за ~40 минут (07.10.2026). `bids` в карточках
  монитора — срез на момент intake и устаревает быстро; pre-flight
  `bids > 10` перед POST ставки критичен.
- Ранжирование откликов (официальный гайд): ранг персонализирован под
  работодателя (вид фрилансера ≠ вид работодателя); факторы — отзывы
  (свежесть экспоненциальна, число, размер проектов нелинейно), milestone-
  оборот и частота релизов, отзывчивость (скорость ответа, accept rate,
  штрафы за спам/офсайт), профиль (экзамены, полнота). Ранняя ставка —
  слабый фактор. Sponsored гарантированно топ списка.

## Неизведанное (следующие шаги при необходимости)

- Семантика `amount` в `action=sponsor` (ручной тест на сайте; цену слота
  сайт считает динамически и через API не отдаёт — см. раздел «Апгрейды ставок»).
- PFP-статус аккаунта для чтения (не для детекта ошибкой) — только веб-сессия.
- Покрытие Escrow.com-согласия на будущие проекты.
- Подтверждение детекта назначения ставки по живому случаю.
- `POST /milestones/` и release-действия живьём.
- Паттерн скачивания вложений проекта (`attachments[].file_id` → предположение
  `https://www.freelancer.com/api/files/0.1/files/{file_id}/` не проверено).
