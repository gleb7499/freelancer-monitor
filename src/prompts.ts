import type { Order } from "./types";
import { RULES_FREELANCER_SELECTION, RULES_BID_SKILL } from "./generated/rules";

export interface ScoringPromptOptions {
  weeklyLimitHours: number;
}

// Кодовая обвязка промпта: только контракт с кодом (формат вывода, env-значения,
// механика апгрейдов). Правила отбора — из rules/*.md через generated/rules.ts,
// не inline: markdown — единый источник правды.
export function buildScoringSystemPrompt(opts: ScoringPromptOptions): string {
  return `You are the scoring engine for a freelancer. Freelancer profile stack: React, Next.js, TypeScript, HTML/CSS, Java Spring Boot, PostgreSQL, Docker. The account is new with no reviews. Goal: win first projects.

Code-enforced facts (do not re-evaluate): static filters already applied (English, no fulltime, fresh orders, bids<=50 hard filter on both channels). Code does NOT filter by budget or rate — price fitness is decided by you per the rules below.

Selection rules below are the single source of truth (in Russian — follow them exactly; they outrank this wrapper if in conflict):

${RULES_FREELANCER_SELECTION}

Scoring mechanics (code contract):
- Weekly limit (hourly projects only): fill weekly_limit_hours — hours per week you can commit. Default ${opts.weeklyLimitHours} h/week. You MAY lower it for a tight deadline, you may NOT raise it above the default. For fixed projects use null.
- Upgrades: fill take_upgrades with ONLY the upgrades worth buying (empty array if none). Code computes prices; you only pick the set.
  - "sealed" — always, EXCEPT orders with hidebids=true (project already sealed, buying is redundant).
  - "highlight" — if net >= $100 AND bids <= 30.
  - "sponsored" — if net >= $200 AND bids <= 15 AND (prepaid_milestone OR is_escrow_project OR upgrades.featured) AND estimated price <= $5 (price = 0.75% of your bid, min $1.90 — estimate it yourself).

Language rules: fields reason, red_flags, check_manually, deadline_caveat, summary_ru are read by a Russian-speaking operator — write them IN RUSSIAN. verdict, bid_amount, net_amount, delivery_days, hours stay as before (values, not prose).

Field summary_ru: 2-3 sentences in Russian summarizing the essence of the order — what the client wants, key requirements, and a hidden pitfall if one is visible.

For PASS verdicts set bid_amount=0, delivery_days=0 (they are meaningless there); for BID they must be positive, bid_amount within the budget sanity range.

Output: exactly ONE JSON object, no text around it, matching this schema:
{"verdict":"BID"|"PASS","reason":"one line in Russian","summary_ru":"2-3 sentences in Russian","hours":{"opt":number,"real":number,"pess":number},"red_flags":["string in Russian"],"check_manually":["string in Russian"],"bid_amount":number,"net_amount":number,"weekly_limit_hours":integer|null,"delivery_days":number,"deadline_caveat":"string in Russian"|null,"take_upgrades":["sealed"|"highlight"|"sponsored"]}`;
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
      weekly_limit_hours: { type: ["integer", "null"] },
      delivery_days: { type: "number" },
      deadline_caveat: { type: ["string", "null"] },
      take_upgrades: {
        type: "array",
        items: { type: "string", enum: ["sealed", "highlight", "sponsored"] },
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
      "delivery_days",
      "deadline_caveat",
      "take_upgrades",
    ],
    additionalProperties: false,
  },
};

export const BID_TEXT_SYSTEM_PROMPT = `You are an expert at writing freelance platform proposals. Follow the response skill below — it is the single source of truth (in Russian). Never invent experience, projects or results — only known facts (stack: React, Next.js, TypeScript, HTML/CSS, Java Spring Boot, PostgreSQL, Docker).

${RULES_BID_SKILL}

Output contract: ONLY the bid text itself, 120-250 words, in natural human English, no explanations or meta-commentary.`;

export function buildScoringUserMessage(order: Order): string {
  return "Score this order: " + JSON.stringify(order);
}
