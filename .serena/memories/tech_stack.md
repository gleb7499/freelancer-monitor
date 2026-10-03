# Tech stack

- TypeScript, ESM (`"type": "module"`), no framework — raw Cloudflare Worker (`src/index.ts` entry)
- Runtime: Cloudflare Workers, `compatibility_date = 2025-09-01`, cron trigger `* * * * *`
- Bindings: D1 `DB` (database `freelancer-monitor`, dedup table `seen` — `migrations/0001_seen.sql`), KV `ORDERS_KV` (ring logs, bid cards, alert cursors/flags)
- Toolchain: wrangler ^4, typescript ^5, @cloudflare/workers-types ^5. npm, `package-lock.json` committed
- LLM: Kimi API (`KIMI_API_BASE`/`KIMI_MODEL` in `wrangler.toml [vars]`), JSON-schema structured output
- External APIs: Freelancer.com REST + ajax-api (saved-search alerts), Telegram Bot API
- No test framework, no linter/formatter configured — verification = `tsc --noEmit` + live `/test/*` endpoints
- CI: GitHub Actions `.github/workflows/deploy.yml` — on push to `main`: `npm ci` → typecheck → `wrangler deploy` (secret `CLOUDFLARE_API_TOKEN`)

Non-secret tunables live in `wrangler.toml [vars]` — change there, not in code.
