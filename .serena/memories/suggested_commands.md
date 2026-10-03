# Commands

```bash
npm install              # deps
npm run typecheck        # tsc --noEmit; pretypecheck hook runs gen:rules first
npm run deploy           # wrangler deploy; predeploy hook runs gen:rules first
npm run gen:rules        # regenerate src/generated/rules.ts from rules/*.md (needed after fresh clone)
wrangler dev             # local dev; reads secrets from .dev.vars
wrangler types           # regenerate Env types after wrangler.toml binding changes
wrangler d1 migrations apply freelancer-monitor --remote   # apply D1 migrations
wrangler secret put <NAME>                               # set Worker secret
```

Live testing (deployed worker, header `X-Admin-Token`):
```
GET  /test/kimi-models   — verify Kimi key/model
POST /test/score         — score sample order end-to-end
POST /test/tick          — run one full pipeline tick
POST /test/set-webhook   — register Telegram webhook (once per deploy/URL change)
POST /admin/fl-auth      — hot-swap freelancer-auth-v2 {userId, hash} into KV
```

Windows notes: shell is Git Bash — use `/dev/null` not `NUL`, forward slashes in paths. Prefer built-in file tools over shell.
