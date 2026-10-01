import type { Env, Order, ScoreResult } from "./types";
import { getConfig } from "./config";
import {
  buildScoringSystemPrompt,
  SCORING_JSON_SCHEMA,
  BID_TEXT_SYSTEM_PROMPT,
  buildScoringUserMessage,
} from "./prompts";

export class KimiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "KimiError";
    this.status = status;
  }
}

let jsonSchemaDegraded = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chat(
  env: Env,
  messages: { role: string; content: string }[],
  opts?: { jsonSchema?: object }
): Promise<string> {
  const cfg = getConfig(env);
  const body: Record<string, unknown> = {
    model: cfg.kimiModel,
    messages,
    temperature: 1,
    reasoning_effort: "low",
  };
  if (opts?.jsonSchema) {
    body.response_format = { type: "json_schema", json_schema: opts.jsonSchema };
  }
  const res = await fetch(`${cfg.kimiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.KIMI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new KimiError(text.slice(0, 300), res.status);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

function looksLikeSchemaError(e: KimiError): boolean {
  const msg = (e.message ?? "").toLowerCase();
  return (
    e.status === 400 &&
    (msg.includes("response_format") || msg.includes("json_schema"))
  );
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return JSON.parse(candidate);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export function validateScore(s: any, order: Order): string[] {
  const errors: string[] = [];
  if (s === null || typeof s !== "object" || Array.isArray(s)) {
    return ["score is not an object"];
  }
  if (s.verdict !== "BID" && s.verdict !== "PASS") {
    errors.push("verdict must be BID or PASS");
  }
  if (typeof s.reason !== "string" || s.reason.trim() === "") {
    errors.push("reason must be a non-empty string");
  }
  if (typeof s.summary_ru !== "string" || s.summary_ru.trim() === "") {
    errors.push("summary_ru must be a non-empty string");
  }
  if (
    s.hours === null ||
    typeof s.hours !== "object" ||
    Array.isArray(s.hours)
  ) {
    errors.push("hours must be an object");
  } else {
    for (const k of ["opt", "real", "pess"]) {
      if (
        typeof s.hours[k] !== "number" ||
        !Number.isFinite(s.hours[k]) ||
        s.hours[k] <= 0
      ) {
        errors.push(`hours.${k} must be a positive number`);
      }
    }
  }
  for (const k of ["red_flags", "check_manually"]) {
    if (
      !Array.isArray(s[k]) ||
      s[k].some((x: unknown) => typeof x !== "string")
    ) {
      errors.push(`${k} must be an array of strings`);
    }
  }
  if (
    typeof s.bid_amount !== "number" ||
    !Number.isFinite(s.bid_amount) ||
    s.bid_amount <= 0
  ) {
    errors.push("bid_amount must be a positive number");
  } else if (
    typeof order.budget_min === "number" &&
    typeof order.budget_max === "number"
  ) {
    const lo = order.budget_min * 0.5;
    const hi = Math.min(order.budget_max * 1.5, 50000);
    if (s.bid_amount < lo || s.bid_amount > hi) {
      errors.push(
        `bid_amount ${s.bid_amount} outside sanity range [${lo}, ${hi}]`
      );
    }
  }
  if (
    typeof s.delivery_days !== "number" ||
    !Number.isFinite(s.delivery_days) ||
    s.delivery_days <= 0
  ) {
    errors.push("delivery_days must be a positive number");
  }
  if (!(typeof s.deadline_caveat === "string" || s.deadline_caveat === null)) {
    errors.push("deadline_caveat must be a string or null");
  }
  if (
    s.weekly_limit_hours !== undefined &&
    s.weekly_limit_hours !== null &&
    (typeof s.weekly_limit_hours !== "number" ||
      !Number.isInteger(s.weekly_limit_hours) ||
      s.weekly_limit_hours <= 0)
  ) {
    errors.push("weekly_limit_hours must be a positive integer or null");
  }
  const UPGRADE_IDS = ["sealed", "highlight", "sponsored"];
  if (!Array.isArray(s.take_upgrades)) {
    errors.push("take_upgrades must be an array");
  } else if (
    s.take_upgrades.some(
      (x: unknown) => typeof x !== "string" || !UPGRADE_IDS.includes(x)
    )
  ) {
    errors.push(
      "take_upgrades items must be one of sealed, highlight, sponsored"
    );
  } else if (new Set(s.take_upgrades).size !== s.take_upgrades.length) {
    errors.push("take_upgrades must not contain duplicates");
  }
  return errors;
}

function normalizeScore(s: any, order: Order): ScoreResult {
  const bid = s.bid_amount as number;
  // Freelancer fee: fixed — 10% with $5 minimum; hourly — flat 10%, no minimum.
  const fee = order.type === "hourly" ? bid * 0.1 : Math.max(bid * 0.1, 5);
  const net = Math.round((bid - fee) * 100) / 100;
  let weeklyLimit: number | null = null;
  if (order.type === "hourly") {
    if (
      typeof s.weekly_limit_hours === "number" &&
      Number.isFinite(s.weekly_limit_hours) &&
      s.weekly_limit_hours > 0
    ) {
      weeklyLimit = Math.floor(s.weekly_limit_hours);
    }
  }
  return {
    verdict: s.verdict,
    reason: s.reason,
    summary_ru: s.summary_ru,
    hours: { opt: s.hours.opt, real: s.hours.real, pess: s.hours.pess },
    red_flags: s.red_flags,
    check_manually: s.check_manually,
    bid_amount: bid,
    net_amount: net,
    weekly_limit_hours: weeklyLimit,
    delivery_days: s.delivery_days,
    deadline_caveat: s.deadline_caveat,
    take_upgrades: s.take_upgrades,
  };
}

async function chatWithRetries(
  env: Env,
  messages: { role: string; content: string }[],
  useSchema: boolean
): Promise<string> {
  const delays = [5000, 15000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await chat(env, messages, useSchema ? { jsonSchema: SCORING_JSON_SCHEMA } : undefined);
    } catch (e) {
      if (e instanceof KimiError && e.status === 429 && attempt < delays.length) {
        await sleep(delays[attempt]);
        continue;
      }
      throw e;
    }
  }
}

export async function scoreOrder(env: Env, order: Order): Promise<ScoreResult | null> {
  const cfg = getConfig(env);
  const messages = [
    { role: "system", content: buildScoringSystemPrompt(cfg) },
    { role: "user", content: buildScoringUserMessage(order) },
  ];
  let useSchema = !jsonSchemaDegraded;
  let raw: string;
  try {
    raw = await chatWithRetries(env, messages, useSchema);
  } catch (e) {
    if (useSchema && e instanceof KimiError && looksLikeSchemaError(e)) {
      jsonSchemaDegraded = true;
      raw = await chatWithRetries(env, messages, false);
    } else {
      throw e;
    }
  }

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch {
    parsed = undefined;
  }
  let errors = parsed === undefined ? ["response is not valid JSON"] : validateScore(parsed, order);
  if (errors.length === 0) {
    return normalizeScore(parsed, order);
  }

  const retryMessages = [
    ...messages,
    { role: "assistant", content: raw },
    {
      role: "user" as const,
      content: `Validation failed: ${errors.join("; ")}. Return corrected JSON only.`,
    },
  ];
  try {
    raw = await chatWithRetries(env, retryMessages, !jsonSchemaDegraded);
  } catch (e) {
    if (jsonSchemaDegraded === false && e instanceof KimiError && looksLikeSchemaError(e)) {
      jsonSchemaDegraded = true;
      raw = await chatWithRetries(env, retryMessages, false);
    } else {
      throw e;
    }
  }
  try {
    parsed = extractJson(raw);
  } catch {
    return null;
  }
  errors = validateScore(parsed, order);
  if (errors.length > 0) return null;
  return normalizeScore(parsed, order);
}

export function buildBidMessages(
  order: Order,
  score: ScoreResult
): { role: string; content: string }[] {
  const weeklyNote =
    order.type === "hourly" && score.weekly_limit_hours !== null
      ? `\nWeekly availability limit for this bid: ${score.weekly_limit_hours} hours/week — if the text mentions hours per week or availability, do not exceed it.`
      : "";
  return [
    { role: "system", content: BID_TEXT_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        "Order:\n" +
        JSON.stringify(order) +
        "\n\nValidated score:\n" +
        JSON.stringify(score) +
        weeklyNote +
        "\n\nWrite the bid text now.",
    },
  ];
}

export async function generateBidText(
  env: Env,
  messages: { role: string; content: string }[]
): Promise<string> {
  return (await chat(env, messages)).trim();
}
