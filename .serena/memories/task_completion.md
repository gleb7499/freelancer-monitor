# Task completion checklist

1. `npm run typecheck` — must pass before any commit (auto-runs `gen:rules`).
2. If `wrangler.toml` bindings changed: `wrangler types` then typecheck again.
3. If behavior/pipeline changed: verify live via `/test/tick` (header `X-Admin-Token`) on the deployed worker and confirm Telegram cards arrive. `/test/score` for scoring changes, `/test/kimi-models` for model/key changes.
4. No linter, formatter, or unit tests exist — typecheck + live test endpoints are the whole gate.
5. Deploy: push to `main` (CI deploys) or `npm run deploy`. Worker secrets persist across deploys.
6. Never commit `.dev.vars`, `src/generated/rules.ts`, or any secret.
