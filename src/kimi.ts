import type { Env, Order, ScoreResult } from "./types";
import { getConfig, type Config } from "./config";
import {
  buildScoringSystemPrompt,
  SCORING_JSON_SCHEMA,
  BID_TEXT_SYSTEM_PROMPT,
  BID_TEXT_MAX_CHARS,
  buildScoringUserMessage,
  type ScoringContext,
} from "./prompts";
import { getBidsBalance } from "./bids-balance";

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

// Курс родной валюты заказа за 1 USD — восстанавливается из бюджета.
function orderRate(order: Order): number {
  return order.budget_min > 0 && order.budget_min_original > 0
    ? order.budget_min_original / order.budget_min
    : 1;
}

// Шаг круглой сетки ставки по величине суммы.
function gridStep(amount: number): number {
  if (amount < 100) return 5;
  if (amount < 2000) return 10;
  if (amount < 5000) return 25;
  if (amount < 10000) return 50;
  return 100;
}

// Округление к ближайшей точке сетки; ровно половина — вверх.
function roundBid(amount: number): number {
  const step = gridStep(amount);
  const base = Math.floor(amount / step) * step;
  return amount - base >= step / 2 ? base + step : base;
}

function roundBidDown(amount: number): number {
  const step = gridStep(amount);
  return Math.floor(amount / step + 1e-9) * step;
}

// USD-эквивалент суммы в родной валюте заказа.
function toUsd(amount: number, rate: number): number {
  return amount / rate;
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
  // Для PASS модель ставит нули (bid_amount/delivery_days не имеют смысла) —
  // принимаем >= 0. Для BID — строго > 0 и sanity-диапазон по бюджету.
  if (
    typeof s.bid_amount !== "number" ||
    !Number.isFinite(s.bid_amount) ||
    s.bid_amount < 0 ||
    (s.verdict === "BID" && s.bid_amount <= 0)
  ) {
    errors.push("bid_amount must be a non-negative number (positive for BID)");
  } else if (s.verdict === "BID") {
    // Sanity-диапазон только для BID: для PASS модель ставит фиктивный bid.
    // Проверяем в родной валюте заказа (budget_*_original); fallback на USD-поля.
    const native =
      typeof order.budget_min_original === "number" &&
      typeof order.budget_max_original === "number" &&
      order.budget_max_original > 0;
    const usd =
      !native &&
      typeof order.budget_min === "number" &&
      typeof order.budget_max === "number" &&
      order.budget_max > 0;
    if (native || usd) {
      const minB = native ? order.budget_min_original : order.budget_min;
      const maxB = native ? order.budget_max_original : order.budget_max;
      const lo = minB * 0.5;
      const hi = Math.min(maxB * 1.5, 50000);
      if (s.bid_amount < lo || s.bid_amount > hi) {
        errors.push(
          `bid_amount ${s.bid_amount} outside sanity range [${lo}, ${hi}] (${native ? order.currency_code : "USD"})`
        );
      }
    }
  }
  if (
    typeof s.delivery_days !== "number" ||
    !Number.isFinite(s.delivery_days) ||
    s.delivery_days < 0 ||
    (s.verdict === "BID" && s.delivery_days <= 0)
  ) {
    errors.push("delivery_days must be a non-negative number (positive for BID)");
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
  if (
    typeof s.value_score !== "number" ||
    !Number.isFinite(s.value_score) ||
    s.value_score < 0 ||
    s.value_score > 100
  ) {
    errors.push("value_score must be a number in [0, 100]");
  }
  if (
    typeof s.ai_hours !== "number" ||
    !Number.isFinite(s.ai_hours) ||
    s.ai_hours <= 0
  ) {
    errors.push("ai_hours must be a positive number");
  }
  const UPGRADE_IDS = ["sealed", "sponsored"];
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

function feeFor(order: Order, bid: number, rate: number): number {
  // Freelancer fee в родной валюте: fixed — 10% с минимумом $5 (в валюте заказа),
  // hourly — плоско 10%, без минимума.
  return order.type === "hourly" ? bid * 0.1 : Math.max(bid * 0.1, 5 * rate);
}

export function normalizeScore(s: any, order: Order, cfg: Config): ScoreResult {
  const rate = orderRate(order);
  let bid = s.bid_amount as number;
  let fee = 0;
  let net = 0;
  // Кодовый пересчёт value_score — LLM-арифметике не доверяем.
  // bid_amount и net_amount — в родной валюте заказа; score считаем в USD-пересчёте.
  //
  // Цена — ДЕТЕРМИНИРОВАННАЯ формула стратегии первых отзывов (не предложение LLM):
  // fixed и hourly: max(низ вилки; средняя конкурентная ставка × 0.65) — низкая
  // цена, но не ниже дна вилки (платформа ниже дна всё равно не примет, а битую
  // ставку генерировать незачем). bid_avg приходит в USD — пересчитываем в родную
  // валюту тем же курсом из бюджета. Ставок ещё нет (bid_avg = null) — низ вилки.
  let valueScore = 0;
  if (s.verdict === "BID" && bid > 0) {
    let target = bid;
    if (order.budget_min_original > 0) {
      if (order.bid_avg != null && order.bid_avg > 0) {
        // bid_avg в USD, rate = родная валюта за 1 USD → умножаем.
        target = Math.max(order.budget_min_original, order.bid_avg * rate * 0.65);
      } else {
        target = order.budget_min_original;
      }
    }
    bid = roundBid(target);
    // Sanity-кап: не выше 150% верха вилки (страховка, в норме не срабатывает).
    if (order.budget_max_original > 0) {
      const cap = order.budget_max_original * 1.5;
      if (bid > cap) bid = roundBidDown(cap);
    }
    const scoreFor = (b: number) => {
      const f = feeFor(order, b, rate);
      const n = b - f;
      return Math.min(
        100,
        Math.round((toUsd(n, rate) / s.ai_hours / cfg.targetHourly) * 100)
      );
    };
    // Соседняя точка ради score НЕ поднимает цену: цена — детерминированная
    // формула стратегии отзывов; низкий score — ожидаемое следствие, порог
    // решает force-pass ниже, а не подтягивание ставки.
    valueScore = scoreFor(bid);
    fee = feeFor(order, bid, rate);
    net = Math.round((bid - fee) * 100) / 100;
    // score пересчитываем от финального net (совпадает с scoreFor(bid), но для ясности).
    valueScore = scoreFor(bid);
  }
  // План этапов для fixed — по итоговой ставке в USD-эквиваленте.
  let milestonePlan: number[] | null = null;
  if (s.verdict === "BID" && order.type === "fixed" && net > 0) {
    const netUsd = net / rate;
    milestonePlan =
      netUsd > 1000
        ? [30, 30, 30, 10]
        : netUsd >= 200
          ? [30, 30, 40]
          : [30, 70];
  }
  let verdict: "BID" | "PASS" = s.verdict;
  if (verdict === "BID" && valueScore < cfg.bidMinScore) {
    console.warn("scoreOrder: BID force-passed by code recheck", {
      id: order.id,
      valueScore,
      bidMinScore: cfg.bidMinScore,
      net,
      ai_hours: s.ai_hours,
    });
    verdict = "PASS";
    valueScore = 0;
  }
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
    verdict,
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
    value_score: valueScore,
    ai_hours: s.ai_hours,
    milestone_plan: milestonePlan,
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
  let bidsCtx: ScoringContext = { bidsBalance: null, nextBidInMinutes: null };
  try {
    const b = await getBidsBalance(env);
    bidsCtx = { bidsBalance: b.balance, nextBidInMinutes: b.nextBidInMinutes };
  } catch (e) {
    console.warn("scoreOrder: bids balance unavailable", String(e));
  }
  const messages = [
    { role: "system", content: buildScoringSystemPrompt(cfg) },
    { role: "user", content: buildScoringUserMessage(order, bidsCtx) },
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
    return normalizeScore(parsed, order, cfg);
  }
  console.error("scoreOrder first-pass validation failed", {
    id: order.id,
    errors,
    raw: raw.slice(0, 500),
  });

  const nativeBudget =
    typeof order.budget_min_original === "number" &&
    typeof order.budget_max_original === "number" &&
    order.budget_max_original > 0;
  const hintMin = nativeBudget ? order.budget_min_original : order.budget_min;
  const hintMax = nativeBudget ? order.budget_max_original : order.budget_max;
  const hintCurrency = nativeBudget ? order.currency_code : "USD";
  const bidHint =
    typeof hintMax === "number" && hintMax > 0
      ? `If verdict is BID, bid_amount (in ${hintCurrency}) must be within [${hintMin * 0.5}, ${Math.min(hintMax * 1.5, 50000)}]; for PASS use 0 for bid_amount and delivery_days.`
      : "For PASS use 0 for bid_amount and delivery_days.";
  const retryMessages = [
    ...messages,
    { role: "assistant", content: raw },
    {
      role: "user" as const,
      content: `Validation failed: ${errors.join("; ")}. ${bidHint} Return corrected JSON only.`,
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
  if (errors.length > 0) {
    console.error("scoreOrder retry validation failed", {
      id: order.id,
      errors,
      raw: raw.slice(0, 500),
    });
    return null;
  }
  return normalizeScore(parsed, order, cfg);
}

export function buildBidMessages(
  order: Order,
  score: ScoreResult,
  portfolio?: import("./enrich").PortfolioInfo | null
): { role: string; content: string }[] {
  const weeklyNote =
    order.type === "hourly" && score.weekly_limit_hours !== null
      ? `\nWeekly availability limit for this bid: ${score.weekly_limit_hours} hours/week — if the text mentions hours per week or availability, do not exceed it.`
      : "";
  let portfolioBlock = "";
  if (portfolio && portfolio.items.length > 0) {
    const lines = portfolio.items
      .map((it) => `- ${it.title}: ${it.description}`)
      .join("\n");
    portfolioBlock =
      `\n\nPortfolio published on the platform profile (titles + descriptions below).` +
      ` When the client asks for examples/links or a piece is directly relevant, reference` +
      ` 1-2 items BY TITLE ONLY — never paste any URL in the bid text. Instead point to the` +
      ` profile and mention that a live demo link sits at the end of that project's` +
      ` description on the profile. This is always stronger than emphasizing the new account.` +
      ` Never invent project names or links.\n${lines}`;
  }
  const milestoneNote =
    score.milestone_plan && score.milestone_plan.length > 0
      ? `\nMilestone plan (code-set, fixed in stone): first milestone 30% of the bid upfront,` +
        ` then ${score.milestone_plan.slice(1).join("% / ")}% on the following stages` +
        ` (${score.milestone_plan.join("/")}). State these exact shares in the bid text as the payment structure.`
      : "";
  const priceNote =
    `\nPricing context (code-set): the bid is ${score.bid_amount} ${order.currency_code}` +
    ` — a deliberately low, review-farming price (bottom of the range or 0.65x the` +
    ` average competitor bid). The bid text must NOT call this a "discount off my usual rate";` +
    ` explain it as: an experienced developer for whom this platform is new, pricing low to earn` +
    ` the first review here — with the usual standard of work.`;
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
        portfolioBlock +
        milestoneNote +
        priceNote +
        "\n\nWrite the bid text now.",
    },
  ];
}

// Plaintext-санитайзер текста ставки: ASCII-only (платформа/клиенты коверкают
// юникод-типографику и Markdown). Текст не ломаем — заменяем, остатки логируем.
export function sanitizeBidText(text: string): string {
  let t = text;
  t = t.replace(/[\u2014\u2013]/g, "-"); // em/en dash
  t = t.replace(/\u2192/g, "->"); // стрелка
  t = t.replace(/[\u00AB\u00BB\u201C\u201D]/g, '"'); // кавычки-ёлочки и лапки
  t = t.replace(/[\u2018\u2019]/g, "'"); // одинарные кавычки
  t = t.replace(/\u2022/g, "-"); // маркер списка
  t = t.replace(/\u2026/g, "..."); // многоточие
  // Markdown: жирный/подчёркивание/зачёркивание/бэктики — удалить символы.
  t = t.replace(/\*\*|__|~~|`/g, "");
  // Заголовочные маркеры "### " в начале строки.
  t = t.replace(/^#{1,6}\s+/gm, "");
  const nonAscii = Array.from(
    new Set(Array.from(t).filter((ch) => (ch.codePointAt(0) ?? 0) > 127))
  );
  if (nonAscii.length > 0) {
    console.warn("sanitizeBidText: non-ASCII characters remain", nonAscii);
  }
  return t.trim();
}

// Жёсткий кап длины текста ставки (платформа не даёт редактировать длиннее
// 1500 символов). Обрезаем по границе предложения, не посередине слова.
export function capBidText(text: string, max = BID_TEXT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBoundary = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
    cut.lastIndexOf("\n"),
  );
  const keep = lastBoundary > max * 0.6 ? lastBoundary + 1 : cut.lastIndexOf(" ");
  const candidate = (keep > max * 0.5 ? cut.slice(0, keep) : cut).trimEnd();
  return candidate.replace(/[,;:\s-]+$/, "") + ".";
}

export async function generateBidText(
  env: Env,
  messages: { role: string; content: string }[]
): Promise<string> {
  let text = sanitizeBidText(await chat(env, messages));
  if (text.length > BID_TEXT_MAX_CHARS) {
    // Одна попытка сжать осознанно; если снова перебор — жёсткая обрезка.
    try {
      const retry = await chat(env, [
        ...messages,
        { role: "assistant", content: text },
        {
          role: "user",
          content: `HARD LIMIT exceeded: the bid text is ${text.length} characters, the platform maximum is ${BID_TEXT_MAX_CHARS}. Rewrite it COMPLETE in at most 1400 characters — keep the hook, the price and the milestone terms, cut examples and repetitions. Output only the bid text.`,
        },
      ]);
      const shorter = sanitizeBidText(retry);
      if (shorter.length <= BID_TEXT_MAX_CHARS) return shorter;
    } catch (e) {
      console.warn("generateBidText compression retry failed:", String(e));
    }
    console.warn("generateBidText: hard-capping bid text", {
      before: text.length,
      after: Math.min(text.length, BID_TEXT_MAX_CHARS),
    });
    text = capBidText(text);
  }
  return text;
}
