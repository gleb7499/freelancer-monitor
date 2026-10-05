import type { Order } from "./types";
import { RULES_FREELANCER_SELECTION, RULES_BID_SKILL } from "./generated/rules";

export interface ScoringPromptOptions {
  weeklyLimitHours: number;
  targetHourly: number;
  bidMinScore: number;
}

export interface ScoringContext {
  bidsBalance: number | null;
  nextBidInMinutes: number | null;
}

// Кодовая обвязка промпта: только контракт с кодом (формат вывода, env-значения,
// механика value-score и апгрейдов). Правила отбора — из rules/*.md через generated/rules.ts,
// не inline: markdown — единый источник правды.
export function buildScoringSystemPrompt(opts: ScoringPromptOptions): string {
  return `You are the scoring engine for a freelancer. Freelancer profile stack: React, Next.js, TypeScript, HTML/CSS, Java Spring Boot, PostgreSQL, Docker. The account is new with no reviews. Goal: win first projects.

Code-enforced facts (do not re-evaluate): static filters already applied (English, no fulltime, fresh orders; code already drops orders with bids > 10 before you see them). Code does NOT filter by budget or rate — price fitness is decided by you per the rules below.

Selection rules below are the single source of truth (in Russian — follow them exactly; they outrank this wrapper if in conflict):

${RULES_FREELANCER_SELECTION}

Value-score mechanics (code contract — code will REJECT BID if recalculated score < ${opts.bidMinScore}, recalculation ignores your arithmetic):
- bid_amount and net_amount are in the ORDER CURRENCY. The final bid amount is set BY CODE, not by you: fixed and hourly both use max(bottom of the budget range; 0.65 x average competitor bid) — never below the bottom — snapped to a round grid. If no competitor bids exist yet — the bottom of the range. This is the review-farming strategy: deliberately low price, so do NOT raise bid_amount hoping to lift value_score — put any positive placeholder.
- Estimate ai_hours: hours of work assuming the freelancer delivers with a swarm of AI agents (fast). NEVER mention AI agents or AI-assisted speed in any client-facing field.
- value_score = clamp(0..100, usd_rate / $${opts.targetHourly} * 100), computed in USD by code. A low price gives a low score — that is EXPECTED in this strategy and is not a reason to PASS a good stack fit.
- Thresholds: value_score < ${opts.bidMinScore} → verdict MUST be PASS. Otherwise verdict by stack fit and risk.
- Freshness reality: you see orders SECONDS after publication; bids = 0 means nothing, dozens arrive within minutes. Being early helps weakly — rank is dominated by reviews, milestone history and profile, not chronology.
- Low bids balance context (from user message): if bids_balance is 1–2 and next_bid_in_minutes is large, be pickier: treat value_score < 20 as PASS.

Scoring mechanics (code contract):
- Weekly limit (hourly projects only): fill weekly_limit_hours — hours per week you can commit. Default ${opts.weeklyLimitHours} h/week. You MAY lower it for a tight deadline, you may NOT raise it above the default. For fixed projects use null.
- Milestones: for fixed projects the code computes a milestone plan (milestone_plan field): always 30% upfront, then the rest split by project size — 30/70, 30/30/40, or 30/30/30/10 (up to 4 parts). Use it in the bid text when describing payment terms; hourly projects have no milestone plan.
- Upgrades: fill take_upgrades with ONLY the upgrades worth buying (empty array if none). Code computes price estimates; you only pick the set.
  - "sealed" — always, EXCEPT orders with hidebids=true (project already sealed).
  - If bids <= 5 (first five bidders) — ONLY sealed. "sponsored" is FORBIDDEN there.
  - If 5 < bids <= 10 — "sponsored" at your discretion when ALL hold (USD equivalents, estimate via the budget exchange rate): fixed project, net >= $100, reliable client (deposit_made OR is_escrow_project OR prepaid_milestone OR client rating >= 4), estimated sponsored price (0.75% of the bid, min $1.90, max $19.99 — dynamic in reality) <= min($6, net x 0.03). The slot is ONE per project: whoever buys first takes it, there is no auction, the position does not degrade as bids accumulate.

Language rules: fields reason, red_flags, check_manually, deadline_caveat, summary_ru are read by a Russian-speaking operator — write them IN RUSSIAN. verdict, bid_amount, net_amount, delivery_days, hours, value_score, ai_hours stay as before (values, not prose).

Field summary_ru: 2-3 sentences in Russian summarizing the essence of the order — what the client wants, key requirements, and a hidden pitfall if one is visible.

Client context: the order JSON may contain a "client" object (nullable) with fields: payment_verified, deposit_made, email_verified, phone_verified (boolean|null); rating, review_count (number|null); registered_ts (number|null); country, open_projects (string|null or number|null); skill_ids (number[]|null). Semantics: payment_verified=false is a strong red flag; deposit_made=true adds payment reliability; rating/review_count is the employer's reputation; open_projects is the approximate number of open orders. If data is present — account for it directly and do NOT ask to verify manually. If "client" is absent or all its fields are null — payment reliability is UNKNOWN: treat it as a risk factor in your judgment (weigh it in value_score/reason/red_flags and mention in check_manually), but the verdict is still YOURS — never auto-BID and never auto-PASS just because the data is missing.
- Artifacts: the order JSON may contain an "artifacts" array — parsed contents of files attached to the order and of external pages linked in the description (entry placeholders mean the file is binary and was not extracted). ALWAYS take artifacts into account when estimating hours and writing check_manually: they are part of the client's requirements, not optional reading.

For PASS verdicts set bid_amount=0, net_amount=0, delivery_days=0, value_score=0 (they are meaningless there); for BID they must be positive, bid_amount a round amount within the budget sanity range in the order currency.

Output: exactly ONE JSON object, no text around it, matching this schema:
{"verdict":"BID"|"PASS","reason":"one line in Russian","summary_ru":"2-3 sentences in Russian","hours":{"opt":number,"real":number,"pess":number},"red_flags":["string in Russian"],"check_manually":["string in Russian"],"bid_amount":number,"net_amount":number,"value_score":number,"ai_hours":number,"weekly_limit_hours":integer|null,"delivery_days":number,"deadline_caveat":"string in Russian"|null,"take_upgrades":["sealed"|"sponsored"]}`;
}

export const SCORING_JSON_SCHEMA = {
  name: "order_score",
  strict: true,
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["BID", "PASS"] },
      reason: { type: "string" },
      summary_ru: { type: "string" },
      hours: {
        type: "object",
        properties: {
          opt: { type: "number" },
          real: { type: "number" },
          pess: { type: "number" },
        },
        required: ["opt", "real", "pess"],
        additionalProperties: false,
      },
      red_flags: { type: "array", items: { type: "string" } },
      check_manually: { type: "array", items: { type: "string" } },
      bid_amount: { type: "number" },
      net_amount: { type: "number" },
      value_score: { type: "number" },
      ai_hours: { type: "number" },
      weekly_limit_hours: { type: ["integer", "null"] },
      delivery_days: { type: "number" },
      deadline_caveat: { type: ["string", "null"] },
      take_upgrades: {
        type: "array",
        items: { type: "string", enum: ["sealed", "sponsored"] },
      },
    },
    required: [
      "verdict",
      "reason",
      "summary_ru",
      "hours",
      "red_flags",
      "check_manually",
      "bid_amount",
      "net_amount",
      "value_score",
      "ai_hours",
      "delivery_days",
      "deadline_caveat",
      "take_upgrades",
    ],
    additionalProperties: false,
  },
};

export const BID_TEXT_SYSTEM_PROMPT = `You are an expert at writing freelance platform proposals. Follow the response skill below — it is the single source of truth (in Russian). Never invent experience, projects or results — only known facts (stack: React, Next.js, TypeScript, HTML/CSS, Java Spring Boot, PostgreSQL, Docker).

${RULES_BID_SKILL}

Output contract: ONLY the bid text itself, in natural human English, no explanations or meta-commentary. Plain text only: ASCII characters only — no em/en dashes (use "-"), no arrows, no curly quotes, no Markdown formatting (no bold/italic/backticks); lists only with "- " if needed. HARD LIMIT: at most 1500 characters total (the platform does not allow editing a bid longer than that after posting — verified 2026-10-05). Aim for 1200-1400 characters; if the material overflows, cut examples and repetitions, never the hook or the price. 120-250 words.`;

export const BID_TEXT_MAX_CHARS = 1500;

export function buildScoringUserMessage(order: Order, ctx?: ScoringContext): string {
  const balance =
    ctx && ctx.bidsBalance !== null
      ? String(ctx.bidsBalance)
      : "unknown";
  const regen =
    ctx && ctx.nextBidInMinutes !== null ? String(ctx.nextBidInMinutes) : "unknown";
  return (
    `Bids balance: ${balance}; next bid regenerates in (minutes): ${regen}.\n` +
    "Score this order: " +
    JSON.stringify(order)
  );
}
