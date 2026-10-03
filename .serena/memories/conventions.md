# Conventions

## rules/ is the single source of truth for selection logic
- `scripts/gen-rules.mjs` embeds `rules/freelancer-правила-отбора.md` + `rules/отклик-скилл.md` into `src/generated/rules.ts` (gitignored), which `prompts.ts` injects into LLM system prompts. Runs via `pretypecheck`/`predeploy` hooks.
- NEVER write selection rules inline in `prompts.ts` — only the code contract (JSON output schema, clamp heuristics, language rules). To change selection behavior, edit the markdown.
- Pricing/scoring values live in section «Ценообразование при скоринге» of `rules/freelancer-правила-отбора.md`.

## LLM output language
- Operator-facing LLM fields (`reason`, `red_flags`, `check_manually`, `deadline_caveat`, `summary_ru`) are Russian by design.

## Post-scoring deterministic rules (LLM never decides these)
- `weekly_limit_hours = min(LLM value, DEFAULT_WEEKLY_LIMIT, 40)` — LLM may lower, never raise.
- Fee: fixed — 10% with $5 min; hourly — flat 10%.
- No price rejection anywhere (no MIN_BUDGET_USD etc.).

## KV/D1 budget discipline (free-tier shaped)
- KV free tier: 1000 put / 1000 list / 100k read per DAY. Count every new KV write against this.
- Seen-dedup in D1 precisely to avoid KV puts; ring log buffers in isolate memory, one flush per tick; no `markStatus` (status trail = ring log).
- D1: max 100 bound params per query — batch SELECT ≤100 ids, INSERT ≤20 rows.

## Style
- No comments explaining what code does; no test files (project has none) unless asked.
- Mixed Russian/English in docs is normal for this repo; code identifiers English.
