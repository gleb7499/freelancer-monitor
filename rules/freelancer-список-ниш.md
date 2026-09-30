# Freelancer.com — Список ниш (единый источник правды)

> Дата утверждения: 2026-09-29
> Статус: позиционирование — **fullstack: React + Spring Boot + HTML/CSS** (профиль @gleb7499, headline «Full Stack Dev | React & Spring Boot | HTML/CSS», $18/h). Тексты профиля и портфолио: профиль-источник-правды.md, портфолио-проекты.md.
> Приоритет: козырь — **фронт и бек одним исполнителем** (ведущий блок A). Вёрстка — опора портфолио (проекты Support Chat, Real Estate Card), а не главный товар. Бек — фоном. Docker/деплой — мелкий добор.
> Техника: каждая ниша = один запрос монитора. Запросы используются как параметр `query` API (`/api/projects/0.1/projects/active/`) + `jobs[]` (ID скиллов). Синтаксис булев: `AND OR NOT` (капс), `"фраза"`, `(скобки)` — проверено 2026-09-29.
> На нишу может быть несколько запросов (строгий / широкий). Каждый запрос самодостаточен: NOT-группы зашиты внутрь.
> Upwork-версия списка (2026-09-19) не удалена — аккаунт с 148 Connects висит резервно; при возврате на Upwork обновлять отдельно.

## Общие NOT-группы (состав зашит в запросы ниже)

- **Конструкторы/платформы:** wordpress, webflow, wix, squarespace, elementor, shopify, bubble, softr, carrd, framer, showit, readymag, gohighlevel, opencart
- **Дизайн-шум:** designer, "UI/UX", logo, branding
- **QA-шум:** tester, testing, QA
- **Медиа/геймдев:** video, UGC, unity, "3d"
- **Мобильная разработка:** "react native", flutter (исключается везде, КРОМЕ вёрсточных ниш — там mobile/mobile-friendly предмет заказа)
- **Senior-крипта:** solana, solidity, "smart contract". DeFi/Web3-фронтенд НЕ исключён — решение за человеком
- **Чужой backend (только в fullstack/backend-нишах):** php, laravel, python, django, ruby, rails, ".NET"
- **Студенческое/бесплатное:** homework, assignment, student, intern, free, unpaid, volunteer — исключено везде

## Скиллы платформы (jobs[])

Справочник: `GET /api/projects/0.1/jobs/` (3483 шт., искать по имени, ID хардкодить).
Текущие: 9 JavaScript, 323 HTML5, 607 PostgreSQL, 741 Git, 759 React.js, 979 Typescript, 1002 Docker, 1042 CSS3, 2370 Spring Boot, 2376 Next.js, 2703 REST API. Java — добрать ID по имени.

---

## Блок A — Fullstack React + Spring Boot (~35%) — ведущий

Своя логика исключений: frontend-слова НЕ исключаем (связка фронт+бек — предмет заказа); `mobile` НЕ исключаем слепо — многие fullstack-сайты хотят и мобильную вёрстку; JavaScript не исключаем (токенизация цепляет Java↔JavaScript).

| # | Ниша | Описание | Запросы (`query`) | jobs[] |
| --- | --- | --- | --- | --- |
| 1 | Fullstack-приложения под ключ | Сайты с личным кабинетом, формы с обработкой, сервисы фронт+бек. Самый высокий чек: клиенту не нужны двое исполнителей | **строгий:** `(fullstack OR "full stack" OR "full-stack") AND (React OR Java OR "Spring Boot") NOT (php OR laravel OR python OR django OR ruby OR rails OR wordpress OR shopify OR ".NET" OR designer OR "UI/UX" OR logo OR branding OR tester OR testing OR QA OR video OR unity OR "3d" OR solana OR solidity OR "smart contract" OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`<br>**широкий:** `(React OR Next OR "front-end" OR frontend) AND (Spring OR "Spring Boot" OR Java) AND (website OR app OR application OR platform OR dashboard OR "from scratch") NOT (php OR laravel OR python OR django OR ruby OR rails OR wordpress OR shopify OR ".NET" OR "react native" OR flutter OR designer OR "UI/UX" OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 759, 2370, 2376 |
| 2 | Бекенд к существующему фронту / новый REST API | Частый заказ: «у нас React-приложение, нужен бек/API». Ты закрываешь половину, которую фронтендеры боятся | **строгий:** `(React OR Next OR frontend) AND ("REST API" OR "Spring Boot" OR backend) AND (integrate OR build OR create OR develop OR "add") NOT (php OR laravel OR python OR django OR ruby OR rails OR wordpress OR shopify OR ".NET" OR "react native" OR flutter OR designer OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`<br>**широкий:** `("REST API" OR RESTful OR "Spring Boot" OR Spring) AND (Java OR React OR frontend OR web) NOT (php OR laravel OR python OR django OR ruby OR rails OR wordpress OR shopify OR ".NET" OR designer OR tester OR testing OR QA OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 2370, 2703, 759 |
| 3 | Админ-панели и CRUD (fullstack) | Админки с API, таблицы, роли, фильтры. Прямое попадание в портфолио (SCADA Mobile, The Southern Crown) | **строгий:** `("admin panel" OR "admin dashboard" OR dashboard OR CRUD OR "data table") AND (React OR Spring OR "Spring Boot" OR fullstack OR "full stack") NOT (php OR laravel OR python OR django OR wordpress OR shopify OR ".NET" OR "react native" OR flutter OR designer OR "UI/UX" OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`<br>**широкий:** `(dashboard OR "admin panel" OR CRUD) AND (React OR TypeScript OR Java OR Spring) AND (API OR backend OR fullstack) NOT (php OR laravel OR python OR wordpress OR shopify OR designer OR tester OR testing OR QA OR video OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 759, 2370, 607 |

---

## Блок B — React / Next.js / TypeScript фронтенд (~35%)

| # | Ниша | Описание | Запросы (`query`) | jobs[] |
| --- | --- | --- | --- | --- |
| 4 | Дашборды / админки (React) | Чисто фронтендовые CRUD-интерфейсы. Портфолио: Southern Crown | **строгий:** `(React OR ReactJS) AND ("admin panel" OR "admin dashboard" OR dashboard OR CRUD OR "data table" OR analytics OR charts) NOT ("react native" OR flutter OR native OR php OR laravel OR python OR ruby OR rails OR wordpress OR shopify OR designer OR "UI/UX" OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`<br>**широкий:** `("admin panel" OR dashboard OR CRUD) AND (React OR TypeScript OR "front-end" OR frontend) NOT ("react native" OR flutter OR php OR wordpress OR python OR designer OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 759, 979 |
| 5 | React bugfix / urgent fixes | Быстрые заказы, короткие циклы, подъём JSS | **строгий:** `(React OR ReactJS OR Next OR NextJS) AND (bug OR fix OR debug OR error OR crash OR broken OR urgent OR "not working" OR troubleshoot OR "white screen") NOT ("react native" OR flutter OR native OR php OR python OR ruby OR rails OR wordpress OR shopify OR designer OR tester OR testing OR QA OR video OR unity OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`<br>**широкий:** `(React OR Next) AND (hotfix OR "console error" OR "build error" OR "blank page" OR glitch) NOT ("react native" OR flutter OR php OR python OR wordpress OR designer OR tester OR testing OR QA OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 759, 2376 |
| 6 | Figma → React / pixel-perfect компоненты | Верстка макетов в React/TS, адаптив. Портфолио: Real Estate Card | **строгий:** `(Figma) AND ("to React" OR "pixel perfect" OR "pixel-perfect" OR implement OR component OR responsive) NOT (designer OR "UI/UX" OR logo OR branding OR wordpress OR webflow OR wix OR shopify OR "react native" OR flutter OR tester OR testing OR QA OR video OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`<br>**широкий:** `(Figma OR XD OR PSD) AND (convert OR implement OR slice OR responsive OR markup) AND (React OR TypeScript OR JavaScript) NOT (designer OR "UI/UX" OR logo OR branding OR wordpress OR webflow OR wix OR shopify OR "react native" OR flutter OR tester OR testing OR video OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 759, 979, 323 |
| 7 | JS → TypeScript миграция / типизация | Новые проекты на TS, миграции. Платёжеспособнее среднего | **строгий:** `(TypeScript OR typed OR "type safety") AND (React OR JavaScript OR migrate OR migration OR convert) NOT ("react native" OR flutter OR php OR python OR wordpress OR designer OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 979, 9 |
| 8 | Next.js (junior/mid) | SSR/SSG, App Router. Senior SSR-архитектуру без опыта — пас | **строгий:** `(Next OR NextJS OR "Next.js" OR "App Router") AND (React OR frontend OR page OR SSR) NOT ("react native" OR flutter OR native OR php OR python OR ruby OR rails OR wordpress OR shopify OR designer OR tester OR testing OR QA OR video OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 2376, 759 |

---

## Блок C — Вёрстка HTML/CSS (~20%) — опора портфолио

Своя логика исключений: слово `mobile` НЕ исключаем (адаптив/mobile-friendly — предмет заказа); отсекаем только `flutter OR "react native"`.

| # | Ниша | Описание | Запросы (`query`) | jobs[] |
| --- | --- | --- | --- | --- |
| 9 | Вёрстка лендингов / страниц | Лендинги, бизнес-сайты, страницы с нуля. Портфолио: Real Estate Card | **строгий:** `(website OR "landing page" OR "web page" OR "company website" OR "business website") AND (HTML OR CSS OR JavaScript OR markup OR layout OR responsive) NOT (wordpress OR webflow OR wix OR squarespace OR elementor OR shopify OR bubble OR softr OR carrd OR framer OR showit OR readymag OR gohighlevel OR opencart OR "react native" OR flutter OR php OR laravel OR designer OR "UI/UX" OR logo OR branding OR tester OR testing OR QA OR video OR unity OR "3d" OR solana OR solidity OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`<br>**широкий:** `(website OR "landing page" OR site) AND (build OR develop OR create OR "from scratch" OR redesign) AND (HTML OR CSS OR JavaScript OR responsive) NOT (wordpress OR webflow OR wix OR squarespace OR elementor OR shopify OR bubble OR softr OR carrd OR framer OR showit OR readymag OR gohighlevel OR opencart OR "react native" OR flutter OR php OR designer OR "UI/UX" OR video OR tester OR testing OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 323, 1042, 9 |
| 10 | CSS-фиксы / адаптив / баги вёрстки | Починить слетевшую вёрстку, «на телефоне разъехалось». Быстрые заказы | **строгий:** `(HTML OR CSS OR JavaScript OR responsive OR "mobile-friendly" OR "mobile friendly") AND (fix OR bug OR broken OR layout OR alignment OR styling OR overlap OR adapt) NOT (wordpress OR webflow OR wix OR squarespace OR elementor OR shopify OR php OR laravel OR "react native" OR flutter OR designer OR "UI/UX" OR video OR tester OR testing OR QA OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 1042, 323 |

---

## Блок D — Spring Boot backend фоном (~10%)

Bugfix/urgent-ниша на голую Java не заводится — даёт слишком много мусора. Приоритет: сначала заказы с fullstack-связкой (поймаются блоком A), потом чистый backend ниже.

| # | Ниша | Описание | Запросы (`query`) | jobs[] |
| --- | --- | --- | --- | --- |
| 11 | Spring Boot REST API | Новые API, доработка существующих. Портфолио: SCADA Mobile, LeetCode Tracker | **строгий:** `(Java OR Spring OR "Spring Boot") AND ("REST API" OR RESTful OR backend OR "back-end") NOT (php OR python OR django OR ruby OR rails OR laravel OR wordpress OR shopify OR ".NET" OR "react native" OR flutter OR minecraft OR designer OR tester OR testing OR QA OR video OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`<br>**широкий:** `("Spring Boot" OR Spring) AND (API OR microservice OR backend OR "back-end" OR PostgreSQL OR database) NOT (php OR python OR django OR ruby OR rails OR wordpress OR shopify OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer OR designer OR tester OR testing OR QA)` | 2370, 2703, 607 |

---

## Блок E — Docker / деплой (мелкий добор, по всплывающим)

Узкое поле, но заказы короткие и хорошо оплачиваемые относительно трудозатрат; в профиле заявлено («containerize with Docker and deploy to your server»). Kubernetes/Jenkins/Terraform исключены — вне стека.

| # | Ниша | Описание | Запросы (`query`) | jobs[] |
| --- | --- | --- | --- | --- |
| 12 | Docker / деплой на сервер | Контейнеризация приложения, docker-compose, деплой на VPS клиента | **строгий:** `(Docker OR "docker-compose" OR containerize) AND (deploy OR deployment OR server OR VPS OR "set up" OR setup OR install) NOT (kubernetes OR helm OR jenkins OR terraform OR "CI/CD pipeline" OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)`<br>**широкий:** `(deploy OR deployment) AND (Docker OR compose OR container) AND (server OR VPS OR hosting OR Linux) NOT (kubernetes OR helm OR jenkins OR terraform OR homework OR assignment OR student OR intern OR free OR unpaid OR volunteer)` | 1002 |

---

## Примечания к ведению списка

- Пороги отбора (bids ≤ 15, бюджеты, сроки) — НЕ в этом файле, а в freelancer-правила-отбора.md. Здесь только «что искать».
- Если ниша долго (2+ недели) приносит < 1 пригодного заказа в день — смотреть запрос: ослабить строгий → широкий, или добавить синоним.
- Если ниша регулярно приносит офф-стек мимо NOT-фильтров — расширять NOT-группу этой ниши, не трогая остальные.
- Появился новый портфолио-проект под узкую тему (например, WebSockets, аутентификация) — кандидат на новую нишу: сначала обсудить, потом добавлять.
