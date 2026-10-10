// Виртуальная приёмка логики перед live-режимом.
// Запуск: npm run acceptance
import { normalizeScore, validateScore, sanitizeBidText, capBidText, generateBidText } from "../src/kimi";
import { isAwarded } from "../src/milestones";
import { fetchProjectClient, fetchPortfolio, fetchOrderArtifacts, mapUsersResponse, CRYPTO_SKILL_ID } from "../src/enrich";
import { parseFeedBody, mapFeedItem, mapCardToProject } from "../src/sources/freelancer-active";
import { fetchSearchOrders, parseSearchBody } from "../src/sources/freelancer-search";
import { preBidRejectReason } from "../src/service";
import { loadOrderContext, updateOrderContext } from "../src/order-context";
import { formatOrderCard, formatPassCard } from "../src/telegram";
import { enforceUpgradeCap, priceUpgrades, sponsoredDailyLeft, spendSponsored } from "../src/upgrades";
import { isWithinSchedule, parseScheduleArgs, applyScheduleDelta, TIMEZONE_OFFSET_MS } from "../src/schedule";
import { runWithConcurrency, bySubmitTsDesc } from "../src/index";
import { buildBidBody, placeBid } from "../src/bidder";
import { buySealedUpgrade } from "../src/payments";
import type { Order } from "../src/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    failures.push(`${label}: expected ${e}, got ${a}`);
  }
}
function ok(cond: boolean, label: string) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${label}: condition false`);
  }
}

function makeOrder(partial: Partial<Order>): Order {
  return {
    platform: "freelancer",
    niche_id: "test",
    id: 1,
    title: "T",
    url: "https://www.freelancer.com/projects/x/y",
    type: "fixed",
    budget_min: 100,
    budget_max: 500,
    budget_min_original: 100,
    budget_max_original: 500,
    currency_code: "USD",
    currency_sign: "$",
    bids: 0,
    bid_avg: null,
    description: "d",
    language: "en",
    submit_ts: 1,
    deadline_hint: null,
    hidebids: false,
    is_escrow_project: false,
    time_free_bids_expire: null,
    is_seller_kyc_required: false,
    upgrades: { fulltime: false, featured: false, sealed: false, NDA: false, urgent: false, recruiter: false },
    prepaid_milestone: false,
    ...partial,
  } as Order;
}

function makeScore(partial: Record<string, unknown>) {
  return {
    verdict: "BID",
    reason: "r",
    summary_ru: "s",
    hours: { opt: 4, real: 6, pess: 9 },
    red_flags: [],
    check_manually: [],
    bid_amount: 250,
    net_amount: 225,
    value_score: 50,
    ai_hours: 6,
    weekly_limit_hours: null,
    delivery_days: 5,
    deadline_caveat: null,
    take_upgrades: ["sponsored"],
    ...partial,
  };
}

const cfg = {
  targetHourly: 20,
  bidMinScore: 10,
  weeklyLimitHours: 40,
  // Потолки фазы 0 (как в wrangler.toml).
  phaseMaxBids: 15,
  phaseBudgetFixedUsd: 50,
  phaseBudgetHourlyUsd: 15,
} as any;

// ---------- A. normalizeScore: округление сетки (без пола/капа: нулевой бюджет) ----------
{
  const o = makeOrder({ budget_min: 0, budget_max: 0, budget_min_original: 0, budget_max_original: 0 });
  eq(normalizeScore(makeScore({ bid_amount: 253.56 }), o, cfg).bid_amount, 250, "grid: 253.56 -> 250");
  eq(normalizeScore(makeScore({ bid_amount: 255 }), o, cfg).bid_amount, 260, "grid: 255 half-up -> 260");
  eq(normalizeScore(makeScore({ bid_amount: 99 }), o, cfg).bid_amount, 100, "grid: 99 -> 100 (step 5)");
  eq(normalizeScore(makeScore({ bid_amount: 101 }), o, cfg).bid_amount, 100, "grid: 101 -> 100 (step 10)");
  eq(normalizeScore(makeScore({ bid_amount: 4999 }), o, cfg).bid_amount, 5000, "grid: 4999 -> 5000 (step 25)");
  eq(normalizeScore(makeScore({ bid_amount: 10001 }), o, cfg).bid_amount, 10000, "grid: 10001 -> 10000 (step 100)");
}

// ---------- B. fee и net (без пола: нулевой бюджет) ----------
{
  const o = makeOrder({ budget_min: 0, budget_max: 0, budget_min_original: 0, budget_max_original: 0 });
  const r = normalizeScore(makeScore({ bid_amount: 250 }), o, cfg);
  eq(r.net_amount, 225, "fee fixed 10%: 250 -> 225");
  const r2 = normalizeScore(makeScore({ bid_amount: 30 }), o, cfg);
  eq(r2.net_amount, 25, "fee fixed min $5: 30 -> 25");
  const oHourly = makeOrder({ type: "hourly", budget_min: 0, budget_max: 0, budget_min_original: 0, budget_max_original: 0 });
  const r3 = normalizeScore(makeScore({ bid_amount: 26 }), oHourly, cfg);
  eq(r3.bid_amount, 25, "hourly rate 26 snapped to round 25");
  eq(r3.net_amount, 22.5, "fee hourly flat 10%, no min: 25 -> 22.5");
}

// ---------- C. валюта заказа (INR) + детерминированная цена ----------
{
  const o = makeOrder({
    budget_min: 130, budget_max: 389,
    budget_min_original: 12500, budget_max_original: 37500,
    currency_code: "INR", currency_sign: "₹",
  });
  // bid_avg = null → детерминированный низ вилки.
  const r = normalizeScore(makeScore({ bid_amount: 24000, ai_hours: 24 }), o, cfg);
  eq(r.bid_amount, 12500, "INR no bids -> bottom of range");
  eq(r.net_amount, 11250, "INR fee 10%");
  // rate = 96.15; net_usd = 11250/96.15 = 117.0; /24/20*100 = 24.4 -> 24
  eq(r.value_score, 24, "INR value_score USD recalc (low is expected)");
  // bid_avg игнорируется кодом (фаза 0: ставка — всегда низ вилки).
  const r2 = normalizeScore(makeScore({ bid_amount: 1, ai_hours: 24, }), { ...o, bid_avg: 100 }, cfg);
  eq(r2.bid_amount, 12500, "INR bid_avg ignored -> bottom");
  // bid_avg 260 USD — тоже низ вилки.
  const r3 = normalizeScore(makeScore({ bid_amount: 1, ai_hours: 24 }), { ...o, bid_avg: 260 }, cfg);
  eq(r3.bid_amount, 12500, "INR high bid_avg still ignored -> bottom");
}

// ---------- C2. детерминированная формула цены (USD) ----------
{
  const o = makeOrder({ budget_min: 100, budget_max: 500, budget_min_original: 100, budget_max_original: 500 });
  // нет ставок → низ вилки.
  eq(normalizeScore(makeScore({ bid_amount: 999 }), o, cfg).bid_amount, 100, "price: no bids -> bottom");
  // bid_avg игнорируется: высокая средняя ставка не поднимает цену.
  eq(normalizeScore(makeScore({ bid_amount: 999 }), { ...o, bid_avg: 400 }, cfg).bid_amount, 100, "price: bid_avg ignored -> bottom 100");
  // низкая средняя ставка тоже не опускает ниже дна вилки (и без того дно).
  eq(normalizeScore(makeScore({ bid_amount: 999 }), { ...o, bid_avg: 120 }, cfg).bid_amount, 100, "price: low bid_avg ignored -> bottom 100");
  // hourly — тот же принцип; снеп сетки кратен 5.
  const oh = makeOrder({ type: "hourly", budget_min: 15, budget_max: 25, budget_min_original: 15, budget_max_original: 25 });
  eq(normalizeScore(makeScore({ bid_amount: 99 }), oh, cfg).bid_amount, 15, "price hourly: no bids -> bottom");
  eq(normalizeScore(makeScore({ bid_amount: 99 }), { ...oh, bid_avg: 30 }, cfg).bid_amount, 15, "price hourly: bid_avg ignored -> bottom 15");
  const oh2 = makeOrder({ type: "hourly", budget_min: 12, budget_max: 25, budget_min_original: 12, budget_max_original: 25 });
  eq(normalizeScore(makeScore({ bid_amount: 99 }), { ...oh2, bid_avg: 20 }, cfg).bid_amount, 10, "price hourly: bid_avg ignored -> snap 10");
}

// ---------- C3. план этапов: валидация LLM-плана ----------
{
  const o = makeOrder({ budget_min: 100, budget_max: 500, budget_min_original: 100, budget_max_original: 500 });
  const plan = (m: unknown) => validateScore(makeScore({ milestones: m }), o);
  const valid = [
    { description: "Project setup and kickoff", share: 30 },
    { description: "Final delivery and handover", share: 70 },
  ];
  eq(plan(valid), [], "milestones: valid plan passes");
  eq(
    plan([{ description: "Project setup and kickoff", share: 30 }, { description: "Final delivery and handover", share: 60 }])
      .some((e) => e.includes("sum to 100")),
    true,
    "milestones: shares != 100 -> error",
  );
  eq(
    plan([{ description: "Project setup and kickoff", share: 40 }, { description: "Final delivery and handover", share: 60 }])
      .some((e) => e.includes("first milestone share must be exactly 30")),
    true,
    "milestones: first share != 30 -> error",
  );
  eq(
    plan([{ description: "Too short", share: 30 }, { description: "Final delivery and handover", share: 70 }])
      .some((e) => e.includes("10-250 characters")),
    true,
    "milestones: 9-char description -> error",
  );
  const longDesc = "x".repeat(251);
  eq(
    plan([{ description: longDesc, share: 30 }, { description: "Final delivery and handover", share: 70 }])
      .some((e) => e.includes("10-250 characters")),
    true,
    "milestones: 251-char description -> error",
  );
  const five = [30, 20, 20, 20, 10].map((share, i) => ({
    description: i === 4 ? "Final delivery and handover" : "Project setup and kickoff",
    share,
  }));
  eq(
    plan(five).some((e) => e.includes("2 to 4 items")),
    true,
    "milestones: 5 items -> error",
  );
  // hourly с массивом -> ошибка.
  const oh = makeOrder({ type: "hourly", budget_min: 15, budget_max: 25, budget_min_original: 15, budget_max_original: 25 });
  const h = validateScore(makeScore({ milestones: valid }), oh);
  eq(h.some((e) => e.includes("must be null for hourly")), true, "milestones: hourly with array -> error");
  // sealed в take_upgrades больше не выбирает LLM.
  const sealed = validateScore(makeScore({ take_upgrades: ["sealed"] }), o);
  eq(sealed.some((e) => e.includes("take_upgrades")), true, "validateScore rejects sealed in take_upgrades");
}

// ---------- C4. normalizeScore: план этапов (суммы, санитайз, фолбэк) ----------
{
  const o = makeOrder({ budget_min: 100, budget_max: 500, budget_min_original: 100, budget_max_original: 500 });
  // LLM-план валиден: сумма этапов точно равна ставке, последний — остаток.
  const llm = [
    { description: "Project setup and kickoff", share: 30 },
    { description: "Final delivery and handover", share: 70 },
  ];
  const r = normalizeScore(makeScore({ bid_amount: 250, ai_hours: 5, milestones: llm }), o, cfg);
  eq(r.bid_amount, 100, "LLM plan: bid recalculated by code (bottom of range)");
  eq(r.milestones?.length, 2, "LLM plan: 2 milestones kept");
  eq(r.milestones![0].amount, 30, "LLM plan: first amount 30% of bid 100");
  // bid_avg 400 игнорируется -> ставка = низ вилки 100: 30% = 30, остаток = 70.
  const r2 = normalizeScore(makeScore({ bid_amount: 1, ai_hours: 5, milestones: llm }), { ...o, bid_avg: 400 }, cfg);
  eq(r2.bid_amount, 100, "LLM plan: bid from deterministic formula");
  const sum2 = r2.milestones!.reduce((a, m) => a + m.amount, 0);
  eq(sum2, r2.bid_amount, "LLM plan: sum of milestones equals bid exactly");
  eq(r2.milestones![1].amount, 70, "LLM plan: last milestone is the remainder");
  // Описания санитайзятся: юникод-тире -> дефис.
  const dash = [
    { description: "Setup — kickoff", share: 30 },
    { description: "Final delivery and handover", share: 70 },
  ];
  const r3 = normalizeScore(makeScore({ bid_amount: 250, ai_hours: 5, milestones: dash }), o, cfg);
  eq(r3.milestones![0].description.includes("-"), true, "LLM plan: em dash sanitized to hyphen");
  ok(!/[—–]/.test(r3.milestones![0].description), "LLM plan: no typographic dashes left");
  // Описание после санитайза короче 10 символов -> типовое
  // ("**Setup** x" — 11 символов до санитайза, "Setup x" — 7 после).
  const short = [
    { description: "**Setup** x", share: 30 },
    { description: "Final delivery and handover", share: 70 },
  ];
  const r4 = normalizeScore(makeScore({ bid_amount: 250, ai_hours: 5, milestones: short }), o, cfg);
  eq(r4.milestones![0].description, "Project setup and kickoff", "LLM plan: sanitized-short description replaced with fallback");
  // Фолбэк по размеру: невалидный LLM-план (сумма 90) -> кодовая схема.
  // Ставка — низ вилки (bid_avg игнорируется): bottom 100 -> net 90 < $200 -> [30, 70].
  const caseOf = (bottom: number, bidAvg: number, milestones: unknown) =>
    normalizeScore(makeScore({ bid_amount: 1, ai_hours: 10, milestones }), makeOrder({
      budget_min: bottom, budget_max: 5000, budget_min_original: bottom, budget_max_original: 5000,
      bid_avg: bidAvg,
    }), cfg);
  const badPlan = [{ description: "Project setup and kickoff", share: 30 }, { description: "Final delivery and handover", share: 60 }];
  const f1 = caseOf(100, 250, badPlan);
  eq(f1.milestones!.map((m) => m.description), ["Project setup and kickoff", "Final delivery and handover"], "fallback < $200: descriptions");
  eq(f1.milestones!.map((m) => m.amount), [30, 70], "fallback < $200: 30/70 of bid 100");
  const f2 = caseOf(300, 800, null);
  eq(f2.bid_amount, 300, "fallback $200-1000: bid = bottom 300 (bid_avg ignored)");
  eq(f2.milestones!.length, 3, "fallback $200-1000: 3 stages");
  eq(f2.milestones![2].description, "Final delivery and handover", "fallback $200-1000: last description");
  const f3 = caseOf(1200, 3000, null);
  eq(f3.bid_amount, 1200, "fallback > $1000: bid = bottom 1200 (bid_avg ignored)");
  eq(f3.milestones!.length, 4, "fallback > $1000: 4 stages");
  const sum3 = f3.milestones!.reduce((a, m) => a + m.amount, 0);
  eq(sum3, f3.bid_amount, "fallback: sum of milestones equals bid exactly");
  // hourly и PASS -> null.
  const oh = makeOrder({ type: "hourly", budget_min: 15, budget_max: 25, budget_min_original: 15, budget_max_original: 25 });
  const h = normalizeScore(makeScore({ bid_amount: 1, milestones: null }), oh, cfg);
  eq(h.milestones, null, "milestones hourly -> null");
}

// ---------- E. force-pass по score ----------
{
  const o = makeOrder({ budget_min: 0, budget_max: 0, budget_min_original: 0, budget_max_original: 0 });
  const r = normalizeScore(makeScore({ bid_amount: 200, ai_hours: 100 }), o, cfg);
  eq(r.verdict, "PASS", "score < BID_MIN_SCORE force-passed");
  eq(r.value_score, 0, "force-pass zeroes score");
  ok(
    r.reason.includes("[код: value_score=") && r.reason.includes("< 10"),
    "force-pass reason carries code note",
  );
}

// ---------- E2. hourly value_score: ставка уже часовая, ai_hours не делим ----------
{
  const oh = makeOrder({
    type: "hourly",
    budget_min: 25, budget_max: 50, budget_min_original: 25, budget_max_original: 50,
  });
  const r = normalizeScore(makeScore({ bid_amount: 30, ai_hours: 30 }), oh, cfg);
  // bid snapped to bottom 25; fee 10% -> net 22.5; 22.5/20*100 = 112 -> 100.
  eq(r.bid_amount, 25, "hourly: bottom of range");
  eq(r.value_score, 100, "hourly: score without ai_hours division");
  eq(r.verdict, "BID", "hourly: high score keeps BID");
}

// ---------- G. rate fallback (budget_min = 0) ----------
{
  const o = makeOrder({ budget_min: 0, budget_min_original: 0, budget_max: 0, budget_max_original: 0 });
  const r = normalizeScore(makeScore({ bid_amount: 200, ai_hours: 5 }), o, cfg);
  eq(r.verdict, "BID", "zero-budget fallback rate=1");
  eq(r.value_score, Math.min(100, Math.round((180 / 5 / 20) * 100)), "zero-budget score as USD");
}

// ---------- H. validateScore ----------
{
  const o = makeOrder({
    budget_min: 130, budget_max: 389,
    budget_min_original: 12500, budget_max_original: 37500,
    currency_code: "INR",
  });
  const bad = validateScore(makeScore({ bid_amount: 60000 }), o);
  ok(bad.some((e) => e.includes("outside sanity range") && e.includes("INR")), "validateScore native sanity range");
  const good = validateScore(makeScore({ bid_amount: 24000 }), o);
  eq(good, [], "validateScore accepts native bid in range");
  const passZeros = validateScore(makeScore({ verdict: "PASS", bid_amount: 0, net_amount: 0, delivery_days: 0, value_score: 0 }), o);
  eq(passZeros, [], "validateScore accepts PASS zeros");
  const dup = validateScore(makeScore({ take_upgrades: ["sponsored", "sponsored"] }), o);
  ok(dup.some((e) => e.includes("duplicates")), "validateScore rejects duplicate upgrades");
}

// ---------- I. sanitizeBidText ----------
{
  const dirty = "Hi — test – arrow → quote «q» ’x’ • bullet … dots **bold** __b__ ~~s~~ `code` ### head";
  const clean = sanitizeBidText(dirty);
  ok(!/[—–→«»’•…]/.test(clean), "sanitize: no typographic chars");
  ok(!/\*\*|__|~~|`/.test(clean), "sanitize: no markdown");
  eq(clean.includes("->"), true, "sanitize: arrow -> ascii");
  eq(clean.includes('"q"'), true, "sanitize: quotes straightened");
}

// ---------- I2. capBidText: жёсткий кап 1500 символов ----------
{
  const short = "Hi - short bid.";
  eq(capBidText(short), short, "cap: short text untouched");
  const long = ("Sentence number %d with several words here. ").repeat(80);
  const capped = capBidText(long);
  ok(capped.length <= 1500, `cap: fits 1500 (got ${capped.length})`);
  ok(/[.?!]$/.test(capped), "cap: ends at sentence boundary");
  ok(!capped.endsWith(" ") && !/,;:-$/.test(capped), "cap: no dangling punctuation");
}

// ---------- J. isAwarded ----------
{
  eq(isAwarded({ time_awarded: 123 } as any), true, "awarded: time_awarded");
  eq(isAwarded({ award_status: "awarded" } as any), true, "awarded: award_status");
  eq(isAwarded({ frontend_bid_status: "Bid accepted" } as any), true, "awarded: frontend accepted");
  eq(isAwarded({ award_status: null, frontend_bid_status: null, time_awarded: null } as any), false, "not awarded: nulls");
  eq(isAwarded({ award_status: "pending" } as any), false, "not awarded: pending");
}

// ---------- K. enforceUpgradeCap (потолок 15% от ставки) ----------
{
  // bid 500: cap $75; sealed $0.10 + sponsored ~$3.75 — оба проходят.
  const capped = enforceUpgradeCap(["sealed", "sponsored"], 500, 450);
  eq(capped.kept.includes("sponsored"), true, "cap 15%: sponsored kept on $500 bid");
  eq(capped.kept.includes("sealed"), true, "cap 15%: sealed kept on $500 bid");
  // bid 30: cap $4.50; sponsored ~$1.90 + $0.10 = $2.00 <= 4.50 — проходит.
  const small = enforceUpgradeCap(["sealed", "sponsored"], 30, 25);
  eq(small.kept.includes("sponsored"), true, "cap 15%: sponsored ~$1.90 fits $4.50 cap");
  // bid 10: cap $1.50; sponsored ~$1.90 + $0.10 = $2.00 > 1.50 — вырезается.
  const tiny = enforceUpgradeCap(["sealed", "sponsored"], 10, 8);
  eq(tiny.kept.includes("sponsored"), false, "cap 15%: sponsored cut on $10 bid");
  eq(tiny.kept.includes("sealed"), true, "cap 15%: sealed survives cut");
}

// ---------- K3. schedule: окно откликов по Минску ----------
{
  const s = { startMin: 480, endMin: 1200, enabled: true }; // 08:00–20:00
  const at = (h: number, m: number) => 86400_000 * 1000 + (h * 60 + m) * 60_000 - TIMEZONE_OFFSET_MS;
  eq(isWithinSchedule(s, at(8, 0)), true, "sched: 08:00 inside");
  eq(isWithinSchedule(s, at(19, 59)), true, "sched: 19:59 inside");
  eq(isWithinSchedule(s, at(7, 59)), false, "sched: 07:59 outside");
  eq(isWithinSchedule(s, at(20, 0)), false, "sched: 20:00 outside");
  eq(isWithinSchedule({ ...s, enabled: false }, at(3, 0)), true, "sched: disabled -> always true");
  eq(parseScheduleArgs("9 22"), { startMin: 540, endMin: 1320 }, "sched: parse 9 22");
  eq(parseScheduleArgs("22 9"), null, "sched: start >= end rejected");
  eq(parseScheduleArgs("9"), null, "sched: one arg rejected");
  eq(parseScheduleArgs("-1 9"), null, "sched: negative rejected");
  eq(parseScheduleArgs("9 25"), null, "sched: >24 rejected");
  // applyScheduleDelta: сдвиги, клемпы и инвариант окна.
  const base = { startMin: 480, endMin: 1200, enabled: true };
  const d1 = applyScheduleDelta(base, "s:+60");
  eq(d1.next.startMin, 540, "sched: start +1h");
  eq(d1.error, null, "sched: start shift ok");
  eq(applyScheduleDelta(base, "s:-60").next.startMin, 420, "sched: start -1h");
  eq(applyScheduleDelta(base, "e:+60").next.endMin, 1260, "sched: end +1h");
  // start+60 дотягивается до end → инвариант нарушен → error, без изменений.
  const tight = { startMin: 1140, endMin: 1200, enabled: true };
  const d2 = applyScheduleDelta(tight, "s:+60");
  ok(d2.error !== null && d2.next === tight, "sched: start+ crossing end rejected");
  // end-60 уходит ниже start → error, без изменений.
  const d3 = applyScheduleDelta(tight, "e:-60");
  ok(d3.error !== null && d3.next === tight, "sched: end- crossing start rejected");
  // Клемпы границ: start не выше 23:00, end не ниже 01:00, end не выше 24:00.
  eq(applyScheduleDelta({ startMin: 1380, endMin: 1440, enabled: true }, "s:+60").next.startMin, 1380, "sched: start clamped at 23:00");
  eq(applyScheduleDelta({ startMin: 0, endMin: 60, enabled: true }, "e:-60").next.endMin, 60, "sched: end clamped at 01:00");
  eq(applyScheduleDelta({ startMin: 1380, endMin: 1440, enabled: true }, "e:+60").next.endMin, 1440, "sched: end clamped at 24:00");
  // Тoggle и пресет.
  eq(applyScheduleDelta(base, "t").next.enabled, false, "sched: toggle off");
  eq(applyScheduleDelta({ ...base, enabled: false }, "t").next.enabled, true, "sched: toggle on");
  const d4 = applyScheduleDelta(base, "p:540:1320");
  eq(d4.next, { startMin: 540, endMin: 1320, enabled: true }, "sched: preset 9-22");
  const d5 = applyScheduleDelta(base, "p:1200:480");
  ok(d5.error !== null && d5.next === base, "sched: inverted preset rejected");
  // Мусор.
  const d6 = applyScheduleDelta(base, "xyz");
  eq(d6.error, "неизвестное действие", "sched: garbage action rejected");
  const d7 = applyScheduleDelta(base, "p:abc:def");
  ok(d7.error !== null && d7.next === base, "sched: non-numeric preset rejected");
}

// ---------- K4. карточка: блок ручных действий ----------
{
  const o = makeOrder({ id: 42 });
  const score = normalizeScore(makeScore({ bid_amount: 250, ai_hours: 5, take_upgrades: ["sealed", "sponsored"] }), o, cfg);
  const plain = formatOrderCard(o, score, "Bid text here.");
  ok(!plain.includes("Ручные действия"), "card: no manual block without manualActions");
  ok(!plain.includes("📝 Суть"), "card: summary line removed");
  ok(!plain.includes("🎯 Value"), "card: value line removed");
  const withMa = formatOrderCard(o, score, "Bid text here.", {
    bidId: 123,
    slotFree: true,
    sponsoredPrice: "sponsored ~$1.90",
  });
  ok(withMa.includes("Ручные действия"), "card: manual block present");
  ok(!withMa.includes("/bid/"), "card: no bid link in manual block");
  ok(withMa.includes("слот свободен"), "card: slot status free");
  const removed = formatOrderCard(o, { ...score, take_upgrades: ["sealed"] }, "Bid.", {
    bidId: null,
    slotFree: false,
    sponsoredPrice: "sponsored ~$1.90",
    sponsoredRemovedNote: "слот занят",
    test: true,
  });
  ok(removed.includes("не берём: слот занят"), "card: sponsored removal note");
  ok(!removed.includes("/bid/"), "card: no bid link in test mode");
  // Регрессия 09.10.2026: note с "<=" («bids <= 15») уходил в Telegram без
  // экранирования → 400 «Unsupported start tag» и карточка терялась целиком.
  const lt = formatOrderCard(o, { ...score, take_upgrades: ["sealed"] }, "Bid.", {
    bidId: null,
    slotFree: true,
    sponsoredPrice: "sponsored ~$1.90",
    sponsoredRemovedNote: "bids <= 15 (sponsored не нужен)",
    test: true,
  });
  ok(!lt.includes("<="), "card: '<=' in removal note is escaped");
  ok(lt.includes("bids &lt;= 15"), "card: escaped note content present");
}

// ---------- K5. sponsoredDailyLeft (mock KV) ----------
async function testSponsoredDaily() {
  const store = new Map<string, string>();
  const env = {
    ORDERS_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, _opts?: unknown) => void store.set(k, v),
    },
  } as any;
  const day = Date.UTC(2026, 9, 8, 12, 0, 0); // 08.10.2026 15:00 Минска
  eq(await sponsoredDailyLeft(env, day), 3, "sponsored: fresh day -> 3 left");
  await spendSponsored(env, day);
  eq(await sponsoredDailyLeft(env, day), 2, "sponsored: after spend -> 2 left");
  await spendSponsored(env, day);
  await spendSponsored(env, day);
  eq(await sponsoredDailyLeft(env, day), 0, "sponsored: limit exhausted -> 0");
}

// ---------- L. fetchProjectClient (mock fetch, закрытый users/0.1/users) ----------
async function testClient() {
  const realFetch = globalThis.fetch;
  const store = new Map<string, string>();
  const env = {
    FL_USER_ID: "94242579",
    FL_AUTH_HASH: "test-hash",
    ORDERS_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, _opts?: unknown) => void store.set(k, v),
    },
  } as any;
  const user = {
    id: 123,
    username: "employer1",
    registration_date: 1700000000,
    location: { country: "Turkey", city: "Adana" },
    status: {
      payment_verified: true,
      email_verified: true,
      deposit_made: true,
      identity_verified: false,
      phone_verified: true,
    },
    reputation: { entire_history: { rating: 4.8, review_count: 12 } },
    employer_reputation: { entire_history: { rating: 5.0, review_count: 3 } },
    jobs: [{ id: 9, name: "Web" }, { id: CRYPTO_SKILL_ID, name: "Cryptocurrency" }],
  };
  const requestedUrls: string[] = [];
  let authHeader: string | null = null;
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    requestedUrls.push(url);
    authHeader = init?.headers?.["freelancer-auth-v2"] ?? null;
    return new Response(JSON.stringify({ status: "success", result: { users: { "123": user } } }), { status: 200 });
  }) as any;

  const full = await fetchProjectClient(env, 123);
  ok(full !== null, "client: mapped from users response");
  eq(full && full.payment_verified, true, "client: payment_verified parsed");
  eq(full && full.deposit_made, true, "client: deposit_made parsed");
  eq(full && full.email_verified, true, "client: email_verified parsed");
  eq(full && full.phone_verified, true, "client: phone_verified parsed");
  eq(full && full.rating, 4.8, "client: rating parsed");
  eq(full && full.review_count, 12, "client: review_count parsed");
  eq(full && full.registered_ts, 1700000000, "client: registered_ts (unix)");
  eq(full && full.country, "Turkey", "client: country parsed");
  eq(full && full.skill_ids, [9, CRYPTO_SKILL_ID], "client: skill_ids from jobs");
  ok(full !== null && (full.open_projects === null || typeof full.open_projects === "number"), "client: open_projects number|null");
  ok(
    requestedUrls.some((u) => decodeURIComponent(u).includes("users[]=123")),
    "client: request by owner id",
  );
  ok(
    requestedUrls.some((u) => u.includes("reputation=true")),
    "client: reputation requested",
  );
  eq(authHeader, "94242579;test-hash", "client: freelancer-auth-v2 header sent");

  // ownerId null — запроса вообще не должно быть.
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }); }) as any;
  eq(await fetchProjectClient(env, null), null, "client: ownerId null -> null");
  eq(calls, 0, "client: ownerId null -> no request");

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: "success", result: {} }), { status: 200 })) as any;
  eq(await fetchProjectClient(env, 123), null, "client: no users block -> null");

  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as any;
  eq(await fetchProjectClient(env, 123), null, "client: 404 -> null");

  globalThis.fetch = (async () => { throw new Error("net down"); }) as any;
  eq(await fetchProjectClient(env, 123), null, "client: network error -> null");

  globalThis.fetch = realFetch;
}

// ---------- L1. mapUsersResponse (чистый маппинг, без сети) ----------
{
  const user = (partial: Record<string, unknown>) => ({
    status: { payment_verified: true },
    reputation: { entire_history: { rating: 4.5, review_count: 7 } },
    jobs: [{ id: 33 }],
    ...partial,
  });
  const wrap = (u: unknown) => ({ status: "success", result: { users: { "7": u } } });

  const base = mapUsersResponse(wrap(user({})), 7);
  eq(base && base.payment_verified, true, "users: payment_verified");
  eq(base && base.rating, 4.5, "users: rating from entire_history");
  eq(base && base.review_count, 7, "users: review_count from entire_history");
  eq(base && base.skill_ids, [33], "users: skill_ids");

  // registration_date строкой тоже принимается.
  const asStr = mapUsersResponse(wrap(user({ registration_date: "2023-11-14 10:00:00" })), 7);
  ok(asStr !== null && asStr.registered_ts !== null && asStr.registered_ts > 1_500_000_000, "users: registration_date string parsed");

  // Явные false не теряются, отсутствующие — null.
  const sparse = mapUsersResponse(
    wrap({ status: { payment_verified: false }, reputation: null, jobs: null }),
    7,
  );
  eq(sparse && sparse.payment_verified, false, "users: explicit false kept");
  eq(sparse && sparse.deposit_made, null, "users: missing field null");

  eq(mapUsersResponse({ status: "success", result: {} }, 7), null, "users: no user -> null");
  eq(mapUsersResponse("garbage", 7), null, "users: garbage -> null");
}

// ---------- N. лента: parseFeedBody / mapFeedItem ----------
{
  const items = [
    { id: 1, type: "project", time: 100, userId: 55 },
    { id: 2, type: "contest", time: 200, userId: 66 },
  ];
  eq(parseFeedBody({ status: "success", result: items }), items, "feed: конверт {status, result:[…]}");
  eq(parseFeedBody({ result: { projects: items } }), items, "feed: обёртка result.projects");
  eq(parseFeedBody(items), items, "feed: голый массив");
  eq(parseFeedBody({ status: "error" }), [], "feed: мусор -> []");
  eq(parseFeedBody(null), [], "feed: null -> []");

  eq(mapFeedItem({ id: 1, time: 100, userId: 55 }), { id: 1, time: 100, ownerId: 55, kind: "project" }, "feed item: полный маппинг");
  eq(mapFeedItem({ id: 1, time: 100 }), { id: 1, time: 100, ownerId: null, kind: "project" }, "feed item: userId отсутствует -> null");
  eq(mapFeedItem({ id: 1, time: 100, userId: "abc" }), { id: 1, time: 100, ownerId: null, kind: "project" }, "feed item: нечисловой userId -> null");
  eq(mapFeedItem({ id: "1", time: "100", userId: "55" }), { id: 1, time: 100, ownerId: 55, kind: "project" }, "feed item: строки коерцятся в числа");
  eq(mapFeedItem({ id: 1, time: 100, type: "contest" })?.kind, "contest", "feed item: contest kind сохраняется");
  eq(mapFeedItem({ id: "x", time: 100 }), null, "feed item: нечисловой id -> null");
  eq(mapFeedItem({ id: 1 }), null, "feed item: нет time -> null");
}

// ---------- N2. публичный поиск: parseSearchBody / fetchSearchOrders ----------
{
  const p = [{ id: 1 }];
  eq(parseSearchBody({ status: "success", result: { projects: p, total_count: 1 } }), p, "search: конверт result.projects");
  eq(parseSearchBody({ status: "success", result: { projects: [] } }), [], "search: пустые projects -> []");
  eq(parseSearchBody({ status: "success", result: { total_count: 5 } }), [], "search: нет projects -> []");
  eq(parseSearchBody({ status: "error" }), [], "search: мусор -> []");
  eq(parseSearchBody(null), [], "search: null -> []");
  eq(parseSearchBody([1, 2]), [], "search: голый массив не принимаем (только result.projects)");
}

async function testSearchChannel() {
  const realFetch = globalThis.fetch;
  const store = new Map<string, string>();
  const env = {
    FREELANCER_API_BASE: "https://www.freelancer.com/api/projects/0.1",
    ORDERS_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, _opts?: unknown) => void store.set(k, v),
    },
  } as any;
  const now = Math.floor(Date.now() / 1000);
  const card = (partial: Record<string, unknown>) => ({
    id: 1,
    title: "Web app",
    seo_url: "cat/web-app",
    type: "fixed",
    submitdate: now - 100,
    budget: { minimum: 100, maximum: 500 },
    currency: { code: "USD", sign: "$", exchange_rate: 1 },
    bid_stats: { bid_count: 3, bid_avg: 200 },
    language: "en",
    owner_info: { id: 4242 },
    ...partial,
  });
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requestedUrls.push(url);
    return new Response(
      JSON.stringify({
        status: "success",
        result: {
          projects: [
            card({}),
            card({ id: 2, submitdate: now - 1000 }), // ниже bootstrap-курсора
            card({ id: 3, type: "contest" }), // контест — не fixed/hourly
            card({ id: 4, language: "ru" }), // не-английский
            card({ id: 5, owner_info: { user_id: 777 } }), // альтернативный ключ owner
          ],
          total_count: 5,
        },
      }),
      { status: 200 },
    );
  }) as any;

  const r = await fetchSearchOrders(env);
  eq(r.error, null, "search: канал без ошибок");
  eq(r.orders.length, 2, "search: старый/контест/не-en отфильтрованы");
  eq(r.orders[0] && r.orders[0].id, 1, "search: id сохранён");
  eq(r.orders[0] && r.orders[0].title, "Web app", "search: карточка нормализована");
  eq(r.orders[0] && r.orders[0].owner_id, 4242, "search: owner_id из owner_info.id");
  eq(r.orders[1] && r.orders[1].owner_id, 777, "search: owner_id из owner_info.user_id");
  ok(requestedUrls.length === 1, "search: один запрос за тик (throttle)");
  ok(
    requestedUrls[0].includes("/api/projects/0.1/projects/active"),
    "search: endpoint projects/active (без двойного api/...)",
  );
  ok(store.has("search:last_submit"), "search: курсор записан");
  ok(store.has("search:last_fetch"), "search: throttle записан");

  // Throttle: повторный вызов в том же тике — skipped, запроса нет.
  const again = await fetchSearchOrders(env);
  eq(again.skipped, true, "search: повторный вызов throttled");
  eq(requestedUrls.length, 1, "search: throttled без запроса");

  // Ошибка канала: сеть падает — ошибка возвращается, имя канала в сообщении.
  store.clear();
  globalThis.fetch = (async () => { throw new Error("net down"); }) as any;
  const down = await fetchSearchOrders(env);
  ok(down.error !== null && down.error.includes("search"), "search: ошибка сети -> error с именем канала");

  globalThis.fetch = realFetch;
}

// ---------- O. карточка: mapCardToProject (shim active_prepaid_milestone) ----------
{
  const milestone = { project_id: 1, amount: 100 };
  const card = {
    id: 1,
    title: "T",
    seo_url: "cat/t",
    type: "fixed",
    submitdate: 123,
    budget: { minimum: 100, maximum: 200 },
    currency: { code: "USD", sign: "$", exchange_rate: 1 },
    upgrades: { featured: true, active_prepaid_milestone: milestone },
  };
  const p = mapCardToProject(card);
  ok(p !== null, "card: валидная карточка -> проект");
  ok(p && p.id === 1, "card: id сохранён");
  ok(p && p.title === "T" && p.type === "fixed", "card: поля совместимы с FreelancerProject");
  ok(
    p && JSON.stringify(p.active_prepaid_milestone) === JSON.stringify(milestone),
    "card: prepaid milestone поднят в верхний уровень (normalizeProject ждёт там)",
  );
  eq(mapCardToProject({ title: "нет id" }), null, "card: без id -> null");
  eq(mapCardToProject(null), null, "card: null -> null");
}

// ---------- L2. fetchPortfolio (mock fetch + mock KV) ----------
async function testPortfolio() {
  const realFetch = globalThis.fetch;
  const store = new Map<string, string>();
  const env = {
    ORDERS_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
    FL_USER_ID: "94242579",
    FL_AUTH_HASH: "test-hash",
  } as any;
  const item = (id: number, title: string, description: string) => ({ id, user_id: 94242579, title, description });
  const usernameBody = () =>
    new Response(JSON.stringify({ status: "success", result: { users: { "94242579": { username: "gleb7499" } } } }), { status: 200 });

  // 1) полный ответ: portfolios + username
  globalThis.fetch = (async (url: string) => {
    if (url.includes("/portfolios/")) {
      return new Response(
        JSON.stringify({ status: "success", result: { portfolios: { 94242579: [item(1, "Proj A", "desc A"), item(2, "Proj B", "x".repeat(900))] } } }),
        { status: 200 });
    }
    return usernameBody();
  }) as any;
  const p1 = await fetchPortfolio(env);
  eq(p1 && p1.items.length, 2, "portfolio: 2 items parsed");
  eq(p1 && p1.username, "gleb7499", "portfolio: username parsed");
  eq(
    p1 && p1.items[0].url,
    "https://www.freelancer.com/u/gleb7499/portfolio-item/1",
    "portfolio: per-item link built",
  );
  ok(p1 !== null && p1.items[1].description.length <= 705, "portfolio: long description truncated");
  ok(store.has("portfolio:cache"), "portfolio: KV cache written");

  // 2) кэш отдаётся без запросов
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }); }) as any;
  const p2 = await fetchPortfolio(env);
  eq(calls, 0, "portfolio: second call served from cache");
  eq(p2 && p2.items.length, 2, "portfolio: cached payload intact");

  // 3) пустое портфолио -> null, кэш не пишется
  store.clear();
  globalThis.fetch = (async (url: string) =>
    url.includes("/portfolios/")
      ? new Response(JSON.stringify({ status: "success", result: { portfolios: { 94242579: [] } } }), { status: 200 })
      : new Response(JSON.stringify({ status: "success", result: {} }), { status: 200 })) as any;
  eq(await fetchPortfolio(env), null, "portfolio: empty -> null");
  eq(store.has("portfolio:cache"), false, "portfolio: empty not cached");

  // 4) username недоступен -> items без ссылок, но контекст живой
  globalThis.fetch = (async (url: string) =>
    url.includes("/portfolios/")
      ? new Response(JSON.stringify({ status: "success", result: { portfolios: { 94242579: [item(3, "Proj C", "d")] } } }), { status: 200 })
      : new Response("nf", { status: 404 })) as any;
  const p3 = await fetchPortfolio(env);
  eq(p3 && p3.items.length, 1, "portfolio: items kept when username missing");
  eq(p3 && p3.items[0].url, null, "portfolio: url null without username");
  store.clear();

  // 5) ошибка сети -> null
  globalThis.fetch = (async () => { throw new Error("down"); }) as any;
  eq(await fetchPortfolio(env), null, "portfolio: network error -> null");

  globalThis.fetch = realFetch;
}

// ---------- K2. пре-гейт до LLM (потолки фазы 0) ----------
{
  const base = makeOrder({ budget_min: 50, budget_min_original: 50 });
  eq(preBidRejectReason(base, cfg), null, "pregate: clean order passes");
  eq(
    preBidRejectReason(makeOrder({ upgrades: { fulltime: false, featured: false, sealed: false, NDA: false, urgent: false, recruiter: true } }), cfg),
    "rej:recruiter",
    "pregate: recruiter rejected",
  );
  eq(
    preBidRejectReason(makeOrder({ is_seller_kyc_required: true }), cfg),
    "rej:kyc-required",
    "pregate: kyc required rejected",
  );
  eq(
    preBidRejectReason(makeOrder({ client: { payment_verified: null, deposit_made: null, email_verified: null, phone_verified: null, rating: null, review_count: null, registered_ts: null, country: null, open_projects: null, skill_ids: [9, CRYPTO_SKILL_ID] } }), cfg),
    "rej:crypto-verified",
    "pregate: crypto skill rejected",
  );
  eq(
    preBidRejectReason(makeOrder({ budget_min: 50, budget_min_original: 50, client: { payment_verified: true, deposit_made: null, email_verified: null, phone_verified: null, rating: null, review_count: null, registered_ts: null, country: null, open_projects: null, skill_ids: [9, 1031] } }), cfg),
    null,
    "pregate: non-crypto skills pass",
  );
  // Гейт конкуренции: границы порога (потолок 15 откликов).
  eq(preBidRejectReason(makeOrder({ bids: 15, budget_min: 50, budget_min_original: 50 }), cfg), null, "pregate: bids = 15 passes");
  eq(preBidRejectReason(makeOrder({ bids: 16 }), cfg), "rej:hot-competition", "pregate: bids = 16 rejected");
  // Бюджетный гейт fixed: дно вилки > $50 — отказ; 50 проходит; 0 (неизвестно) — пропуск.
  eq(preBidRejectReason(makeOrder({ type: "fixed", budget_min: 50 }), cfg), null, "pregate: fixed budget_min = 50 passes");
  eq(preBidRejectReason(makeOrder({ type: "fixed", budget_min: 51 }), cfg), "rej:budget-fixed", "pregate: fixed budget_min = 51 rejected");
  eq(preBidRejectReason(makeOrder({ type: "fixed", budget_min: 0, budget_min_original: 0 }), cfg), null, "pregate: fixed budget_min = 0 (unknown) passes");
  // Бюджетный гейт hourly: ставка > $15/ч — отказ; границы.
  eq(preBidRejectReason(makeOrder({ type: "hourly", budget_min: 15, budget_min_original: 15 }), cfg), null, "pregate: hourly budget_min = 15 passes");
  eq(preBidRejectReason(makeOrder({ type: "hourly", budget_min: 15.5, budget_min_original: 15.5 }), cfg), "rej:budget-hourly", "pregate: hourly budget_min = 15.5 rejected");
  eq(preBidRejectReason(makeOrder({ type: "hourly", budget_min: 0, budget_min_original: 0 }), cfg), null, "pregate: hourly budget_min = 0 (unknown) passes");
  // Пороги берутся из настроек: при потолке 5 откликов bids = 6 уже отказ.
  const cfgTight = { ...cfg, phaseMaxBids: 5, phaseBudgetFixedUsd: 30, phaseBudgetHourlyUsd: 8 };
  eq(preBidRejectReason(makeOrder({ bids: 6 }), cfgTight), "rej:hot-competition", "pregate: threshold from cfg");
  eq(preBidRejectReason(makeOrder({ type: "fixed", budget_min: 31 }), cfgTight), "rej:budget-fixed", "pregate: fixed threshold from cfg");
  eq(preBidRejectReason(makeOrder({ type: "hourly", budget_min: 9 }), cfgTight), "rej:budget-hourly", "pregate: hourly threshold from cfg");
}

// ---------- L3. fetchOrderArtifacts (mock fetch) ----------
async function testArtifacts() {
  const realFetch = globalThis.fetch;
  const env = {} as any;
  const html = "<html><head><style>body{}</style><script>var x=1;</script></head><body><h1>Spec v2</h1><p>Requirements: JWT auth, CRUD, Docker.</p></body></html>";
  const order = makeOrder({
    id: 777,
    description: "Build per the spec at https://example.com/spec.html and the PDF brief.",
  });

  // Проект без вложений + одна html-ссылка + один PDF (бинарный плейсхолдер).
  globalThis.fetch = (async (url: string) => {
    if (url.includes("/projects/?projects[]")) {
      return new Response(JSON.stringify({ status: "success", result: { projects: [{ id: 777, attachments: null, files: null, drive_files: null }] } }), { status: 200 });
    }
    if (url === "https://example.com/spec.html") {
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url === "https://example.com/brief.pdf") {
      return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } });
    }
    return new Response("nf", { status: 404 });
  }) as any;
  const arts = await fetchOrderArtifacts(env, order);
  ok(arts !== null, "artifacts: parsed set returned");
  const urlArt = arts && arts.find((a) => a.source === "url");
  ok(urlArt !== undefined && urlArt.text.includes("Spec v2") && !urlArt.text.includes("var x"), "artifacts: html stripped to text, scripts gone");

  // Описание со ссылкой на PDF — бинарный плейсхолдер, текст не выдумываем.
  const orderPdf = makeOrder({ id: 778, description: "See the brief https://example.com/brief.pdf for details." });
  globalThis.fetch = (async (url: string) => {
    if (url.includes("/projects/?projects[]")) {
      return new Response(JSON.stringify({ status: "success", result: { projects: [{ id: 778 }] } }), { status: 200 });
    }
    if (url === "https://example.com/brief.pdf") {
      return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } });
    }
    return new Response("nf", { status: 404 });
  }) as any;
  const arts2 = await fetchOrderArtifacts(env, orderPdf);
  ok(arts2 !== null && arts2.some((a) => a.text.includes("бинарный файл")), "artifacts: pdf placeholder, no invented text");

  // Всё недоступно → null.
  globalThis.fetch = (async () => new Response("nf", { status: 404 })) as any;
  eq(await fetchOrderArtifacts(env, order), null, "artifacts: nothing fetched -> null");

  globalThis.fetch = realFetch;
}

// ---------- M2. order-context (mock KV по образцу testPortfolio) ----------
async function testOrderContext() {
  const store = new Map<string, string>();
  const env = {
    ORDERS_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
  } as any;
  const o = makeOrder({ id: 555 });
  const score = normalizeScore(makeScore({ bid_amount: 200, ai_hours: 5 }), o, cfg);
  const draft = [{ role: "system", content: "s" }, { role: "user", content: "u" }];

  // 1) update -> load: поля совпадают, createdTs/updatedTs проставлены
  await updateOrderContext(env, o.id, { order: o, score, draftMessages: draft, humanizeMessages: [], bidText: null });
  const c1 = await loadOrderContext(env, o.id);
  ok(c1 !== null, "ctx: created record loaded");
  eq(c1 && c1.order.id, 555, "ctx: order kept");
  eq(c1 && c1.score.bid_amount, score.bid_amount, "ctx: score kept");
  eq(c1 && c1.draftMessages, draft, "ctx: draftMessages kept");
  ok(c1 !== null && c1.createdTs > 0 && c1.updatedTs > 0, "ctx: timestamps set");
  ok(store.has("ctx:order:555"), "ctx: key format ctx:order:<id>");

  // 2) второй update с патчем { bidText }: merge, createdTs не изменился
  const createdTs = c1!.createdTs;
  await new Promise((r) => setTimeout(r, 5));
  await updateOrderContext(env, o.id, { bidText: "Hello bid." });
  const c2 = await loadOrderContext(env, o.id);
  eq(c2 && c2.bidText, "Hello bid.", "ctx: bidText patched");
  eq(c2 && c2.order.id, 555, "ctx: merge kept old fields");
  eq(c2 && c2.createdTs, createdTs, "ctx: createdTs unchanged");
  ok(c2 !== null && c2.updatedTs >= createdTs, "ctx: updatedTs bumped");

  // 3) битый JSON -> null
  store.set("ctx:order:555", "{not json");
  eq(await loadOrderContext(env, 555), null, "ctx: broken JSON -> null");

  // 4) put бросает -> update не падает
  const badEnv = {
    ORDERS_KV: {
      get: async () => null,
      put: async () => { throw new Error("kv down"); },
    },
  } as any;
  try {
    await updateOrderContext(badEnv, 1, { order: o, score });
    ok(true, "ctx: failing put does not throw");
  } catch (e) {
    ok(false, `ctx: failing put does not throw (threw ${String(e)})`);
  }
}

// ---------- M. карточки Telegram ----------
function testCards() {
  const o = makeOrder({
    budget_min: 130, budget_max: 389,
    budget_min_original: 12500, budget_max_original: 37500,
    currency_code: "INR", currency_sign: "₹",
    title: "Test order",
  });
  const score = normalizeScore(makeScore({ bid_amount: 24000, ai_hours: 24 }), o, cfg);
  score.summary_ru = "Суть ".repeat(200);
  score.reason = "Причина ".repeat(100);
  const longBid = ("Word ".repeat(1200)).trim();
  const card = formatOrderCard(o, score, longBid);
  ok(card.length <= 4096, `BID card fits 4096 (got ${card.length})`);
  ok(card.includes("₹12500"), "card: native currency shown (bottom-of-range bid)");
  ok(card.includes("≈$"), "card: USD approx shown");

  const passCard = formatPassCard(o, { ...score, verdict: "PASS", reason: "Чужой стек", red_flags: ["флаг"] });
  ok(passCard.length < 800, `PASS card compact (got ${passCard.length})`);
  ok(!passCard.includes("Апгрейды"), "PASS card: no upgrades");
  ok(!passCard.includes("Value"), "PASS card: no value line");
  ok(passCard.includes("PASS"), "PASS card: verdict present");
}

// ---------- P. пул параллелизма тика (мок: без сети) ----------
async function testConcurrencyPool() {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 12 }, (_, i) => i);
  // Батч из 12 "заказов" при лимите 5: параллелизм реален, но не выше лимита.
  const out = await runWithConcurrency(tasks, 5, async (i) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(15);
    active -= 1;
    return i * 2;
  });
  eq(maxActive, 5, "pool: параллелизм доходит до лимита 5");
  eq(out.length, 12, "pool: все задачи обработаны");
  eq(JSON.stringify(out), JSON.stringify(tasks.map((i) => i * 2)), "pool: порядок результатов сохранён");

  // Лимит 1 — строго последовательно.
  let seq = 0;
  let maxSeq = 0;
  await runWithConcurrency([1, 2, 3], 1, async () => {
    seq += 1;
    maxSeq = Math.max(maxSeq, seq);
    await delay(5);
    seq -= 1;
  });
  eq(maxSeq, 1, "pool: при лимите 1 — последовательно");

  // Лимит больше числа задач — пул не плодит лишние воркеры, пустой батч — no-op.
  let peak = 0;
  let a2 = 0;
  await runWithConcurrency([7, 8], 5, async () => {
    a2 += 1;
    peak = Math.max(peak, a2);
    await delay(5);
    a2 -= 1;
  });
  eq(peak, 2, "pool: воркеров не больше числа задач");
  const empty = await runWithConcurrency([], 5, async () => 1);
  eq(empty.length, 0, "pool: пустой батч — пустой результат");
}

// ---------- P. bidder/payments: тело ставки, гарды, корзина sealed ----------
async function testBidderPayments() {
  const realFetch = globalThis.fetch;
  const score = (milestones: unknown, bid = 260) =>
    ({ bid_amount: bid, delivery_days: 5, milestones } as any);
  const ms = [
    { description: "Project setup and kickoff", amount: 78 },
    { description: "Final delivery and handover", amount: 182 },
  ];

  // buildBidBody: milestone_percentage 50 при 2+ этапах, 100 без плана;
  // showcases всегда []; bidder_id — из веб-авторизации.
  const body2 = buildBidBody(42, 94242579, "Bid text", score(ms));
  eq(body2.milestone_percentage, 50, "bid body: 50 with 2+ milestones");
  eq(body2.showcases, [], "bid body: showcases always empty");
  eq(body2.bidder_id, 94242579, "bid body: bidder_id");
  eq(body2.project_id, 42, "bid body: project_id");
  eq(body2.amount, 260, "bid body: amount from score");
  const bodyNull = buildBidBody(42, 94242579, "Bid text", score(null));
  eq(bodyNull.milestone_percentage, 100, "bid body: 100 without milestones");

  // Окружение placeBid: режим live, веб-сессия в KV, D1-заглушка для леджера.
  const store = new Map<string, string>([
    ["mode", "live"],
    ["fl:auth", JSON.stringify({ userId: "94242579", hash: "test-hash" })],
  ]);
  const env = {
    FREELANCER_API_BASE: "https://www.freelancer.com/api/projects/0.1",
    ORDERS_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, _o?: unknown) => void store.set(k, v),
    },
    DB: {
      prepare: () => ({
        bind: () => ({ run: async () => ({}) }),
        first: async () => null,
      }),
    },
  } as any;
  const order = makeOrder({});

  // Гард: текст 99 символов — reason bid-text-too-short, запрос не уходит.
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }); }) as any;
  const short = await placeBid(env, order, score(ms), "x".repeat(99));
  eq(short.placed, false, "guard: short text not placed");
  eq(short.reason, "bid-text-too-short", "guard: bid-text-too-short reason");
  eq(calls, 0, "guard: no fetch on short text");

  // Полный успешный цикл: ставка -> 2 запроса этапов -> корзина sealed.
  const requests: { url: string; method: string; body: any; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    let body: any = null;
    try { body = JSON.parse(init?.body ?? ""); } catch { /* не JSON */ }
    requests.push({ url, method: init?.method ?? "GET", body, headers: init?.headers ?? {} });
    const okJson = (result: unknown) =>
      new Response(JSON.stringify({ status: "success", result }), { status: 200 });
    if (url.includes("/milestone_requests/")) return okJson({ id: 900 + requests.length });
    if (url.endsWith("/carts/")) return okJson({ id: 777 });
    if (url.includes("/bids/")) return okJson({ id: 555 });
    return okJson({});
  }) as any;

  const placed = await placeBid(env, order, score(ms), "Bid text " + "long enough ".repeat(12) + "end.");
  eq(placed.placed, true, "placeBid: placed");
  eq(placed.bidId, 555, "placeBid: bid id parsed");
  eq(placed.milestones?.requested, 2, "placeBid: 2 milestone requests");
  eq(placed.milestones?.failed, null, "placeBid: no milestone failures");
  eq(placed.sealPurchase, "ok", "placeBid: sealed bought via cart");

  const bidReq = requests.find((r) => r.url.includes("/bids/"));
  eq(bidReq?.body.milestone_percentage, 50, "placeBid: bid body milestone_percentage 50");
  eq(bidReq?.body.bidder_id, 94242579, "placeBid: bid body bidder_id from web auth");
  eq(bidReq?.body.showcases, [], "placeBid: bid body showcases empty");
  eq(bidReq?.headers["freelancer-auth-v2"], "94242579;test-hash", "placeBid: web auth header sent");

  const msReqs = requests.filter((r) => r.url.includes("/milestone_requests/"));
  eq(msReqs.length, 2, "placeBid: 2 milestone POSTs");
  eq(msReqs.reduce((a, r) => a + r.body.amount, 0), 260, "placeBid: milestone amounts sum equals bid");
  eq(msReqs[0].body.bid_id, 555, "placeBid: milestone request carries bid id");
  eq(msReqs[0].body.project_id, 1, "placeBid: milestone request carries project id");
  ok(
    store.has("ms:req:555"),
    "placeBid: milestone requests persisted to KV",
  );

  const cartReq = requests.find((r) => r.url.endsWith("/carts/") && r.method === "POST");
  eq(cartReq?.body.return_action?.destination, "project_view_page", "cart: return destination");
  eq(cartReq?.body.return_action?.payload, "1", "cart: payload = projectId");
  const itemReq = requests.find((r) => r.url.includes("cart_items"));
  eq(itemReq?.body.context_type, "bid_upgrade", "cart item: context_type");
  eq(itemReq?.body.currency, 1, "cart item: currency USD id");
  eq(itemReq?.body.amount, 0.1, "cart item: sealed price $0.10");
  eq(itemReq?.body.context_sub_type, 3, "cart item: sealed sub type 3");
  eq(itemReq?.body.cart_id, 777, "cart item: cart id from create");
  eq(itemReq?.body.context_id, "555", "cart item: context id = bid id");
  const processReq = requests.find((r) => r.url.endsWith("/carts/777") && r.method === "PUT");
  eq(processReq?.body, { action: "process" }, "cart: process body");
  eq(cartReq?.headers["freelancer-auth-v2"], "94242579;test-hash", "cart: web auth header");

  // buySealedUpgrade напрямую: сбой корзины — причина из тела ошибки, дальше не идём.
  let cartCalls = 0;
  globalThis.fetch = (async () => {
    cartCalls++;
    return new Response(JSON.stringify({ error_code: "PAYMENTS_DOWN" }), { status: 500 });
  }) as any;
  const direct = await buySealedUpgrade({ userId: "94242579", hash: "test-hash" }, 555, 1);
  eq(direct, "PAYMENTS_DOWN", "payments: cart failure reason from body");
  eq(cartCalls, 1, "payments: stop on cart failure");

  globalThis.fetch = realFetch;
}

// ---------- Q. сортировка заказов к скорингу: свежие первыми ----------
{
  const o1 = makeOrder({ id: 1, submit_ts: 100 });
  const o2 = makeOrder({ id: 2, submit_ts: 300 });
  const o3 = makeOrder({ id: 3, submit_ts: 200 });
  const sorted = [o1, o2, o3].sort(bySubmitTsDesc);
  eq(sorted.map((o) => o.id), [2, 3, 1], "sort: submit_ts desc (fresh first)");
  eq(bySubmitTsDesc(o1, o1), 0, "sort: equal ts -> 0");
}

// ---------- R. generateBidText: повторная попытка при пустом/павшем черновике ----------
async function testGenerateBidText() {
  const realFetch = globalThis.fetch;
  const store = new Map<string, string>();
  const env = {
    KIMI_API_BASE: "https://api.kimi.ai/coding/v1",
    KIMI_MODEL: "kimi-for-coding",
    KIMI_API_KEY: "test-key",
    ORDERS_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, _o?: unknown) => void store.set(k, v),
    },
  } as any;
  const order = makeOrder({ id: 888 });
  const messages = [{ role: "user", content: "draft" }];
  const reply = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  // 1) первый ответ пустой -> повторный вызов; второй валидный -> текст получен.
  // Всего 3 вызова: 2 черновик + 1 humanize-проход.
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return reply(calls === 1 ? "   " : "Solid draft for the client.");
  }) as any;
  const r1 = await generateBidText(env, order, messages);
  eq(calls, 3, "bidtext: empty first reply -> one retry, then humanize pass");
  eq(r1, "Solid draft for the client.", "bidtext: retry draft returned");

  // 2) первый вызов бросает (сеть) -> повторный; второй валидный.
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw new Error("net down");
    return reply("Recovered draft.");
  }) as any;
  const r2 = await generateBidText(env, order, messages);
  eq(calls, 3, "bidtext: thrown first call -> one retry, then humanize pass");
  eq(r2, "Recovered draft.", "bidtext: retry after exception returned");

  // 3) два пустых ответа -> null (заказ пропускается).
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return reply("");
  }) as any;
  const r3 = await generateBidText(env, order, messages);
  eq(calls, 2, "bidtext: two empty replies -> exactly two attempts");
  eq(r3, null, "bidtext: two empty replies -> null");

  // 4) два исключения -> null.
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("net down");
  }) as any;
  const r4 = await generateBidText(env, order, messages);
  eq(calls, 2, "bidtext: two thrown calls -> exactly two attempts");
  eq(r4, null, "bidtext: two exceptions -> null");

  globalThis.fetch = realFetch;
}

// ---------- запуск ----------
(async () => {
  await testClient();
  await testPortfolio();
  await testArtifacts();
  await testOrderContext();
  await testConcurrencyPool();
  await testSponsoredDaily();
  await testBidderPayments();
  await testSearchChannel();
  await testGenerateBidText();
  testCards();
  console.log(`\nPASS: ${pass}, FAIL: ${fail}`);
  if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures) console.log(" -", f);
    process.exit(1);
  }
  console.log("ALL GREEN");
})();
