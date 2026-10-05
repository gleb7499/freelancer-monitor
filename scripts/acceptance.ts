// Виртуальная приёмка логики перед live-режимом.
// Запуск: npm run acceptance
import { normalizeScore, validateScore, sanitizeBidText, capBidText } from "../src/kimi";
import { isAwarded } from "../src/milestones";
import { fetchProjectClient, fetchPortfolio, fetchOrderArtifacts, CRYPTO_SKILL_ID } from "../src/enrich";
import { preBidRejectReason } from "../src/service";
import { formatOrderCard, formatPassCard } from "../src/telegram";
import { enforceUpgradeCap } from "../src/upgrades";
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
    take_upgrades: ["sealed"],
    ...partial,
  };
}

const cfg = { targetHourly: 20, bidMinScore: 10, weeklyLimitHours: 40 } as any;

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
  // bid_avg в USD: 100×96.15×0.65 = 6250 < низа вилки → низ вилки.
  const r2 = normalizeScore(makeScore({ bid_amount: 1, ai_hours: 24, }), { ...o, bid_avg: 100 }, cfg);
  eq(r2.bid_amount, 12500, "INR avg x 0.65 below bottom -> bottom");
  // bid_avg 260 USD: 260×96.15×0.65 = 16251 > низа → снеп (шаг 100) 16300.
  const r3 = normalizeScore(makeScore({ bid_amount: 1, ai_hours: 24 }), { ...o, bid_avg: 260 }, cfg);
  eq(r3.bid_amount, 16300, "INR avg x 0.65 above bottom -> formula snapped");
}

// ---------- C2. детерминированная формула цены (USD) ----------
{
  const o = makeOrder({ budget_min: 100, budget_max: 500, budget_min_original: 100, budget_max_original: 500 });
  // нет ставок → низ вилки.
  eq(normalizeScore(makeScore({ bid_amount: 999 }), o, cfg).bid_amount, 100, "price: no bids -> bottom");
  // avg 400 x 0.65 = 260 > низа → 260.
  eq(normalizeScore(makeScore({ bid_amount: 999 }), { ...o, bid_avg: 400 }, cfg).bid_amount, 260, "price: avg*0.65 above bottom -> 260");
  // avg 120 x 0.65 = 78 < низа 100 → 100.
  eq(normalizeScore(makeScore({ bid_amount: 999 }), { ...o, bid_avg: 120 }, cfg).bid_amount, 100, "price: avg*0.65 below bottom -> bottom 100");
  // hourly — та же формула; снеп сетки кратен 5.
  const oh = makeOrder({ type: "hourly", budget_min: 15, budget_max: 25, budget_min_original: 15, budget_max_original: 25 });
  eq(normalizeScore(makeScore({ bid_amount: 99 }), oh, cfg).bid_amount, 15, "price hourly: no bids -> bottom");
  eq(normalizeScore(makeScore({ bid_amount: 99 }), { ...oh, bid_avg: 30 }, cfg).bid_amount, 20, "price hourly: max(15, 19.5) -> snap 20");
  const oh2 = makeOrder({ type: "hourly", budget_min: 12, budget_max: 25, budget_min_original: 12, budget_max_original: 25 });
  eq(normalizeScore(makeScore({ bid_amount: 99 }), { ...oh2, bid_avg: 20 }, cfg).bid_amount, 15, "price hourly: max(12, 13) -> snap 15");
}

// ---------- C3. план этапов ----------
{
  const caseOf = (bottom: number, bidAvg: number) =>
    normalizeScore(makeScore({ bid_amount: 1, ai_hours: 10 }), makeOrder({
      budget_min: bottom, budget_max: 5000, budget_min_original: bottom, budget_max_original: 5000,
      bid_avg: bidAvg,
    }), cfg);
  // bottom 100, avg 250 -> max(100, 162.5) = 162.5 -> снеп 165 -> net 148.5 < $200 -> [30, 70].
  eq(JSON.stringify(caseOf(100, 250).milestone_plan), JSON.stringify([30, 70]), "plan < $200 -> 30/70");
  // bottom 300, avg 800 -> max(300, 520) = 520 -> net 468 -> [30, 30, 40].
  eq(JSON.stringify(caseOf(300, 800).milestone_plan), JSON.stringify([30, 30, 40]), "plan $200-1000 -> 30/30/40");
  // bottom 1200, avg 3000 -> max(1200, 1950) = 1950 -> net 1755 -> [30, 30, 30, 10].
  eq(JSON.stringify(caseOf(1200, 3000).milestone_plan), JSON.stringify([30, 30, 30, 10]), "plan > $1000 -> 4 stages");
  // hourly — без плана.
  const h = normalizeScore(makeScore({ bid_amount: 1 }), makeOrder({
    type: "hourly", budget_min: 15, budget_max: 25, budget_min_original: 15, budget_max_original: 25,
  }), cfg);
  eq(h.milestone_plan, null, "plan hourly -> null");
}

// ---------- E. force-pass по score ----------
{
  const o = makeOrder({ budget_min: 0, budget_max: 0, budget_min_original: 0, budget_max_original: 0 });
  const r = normalizeScore(makeScore({ bid_amount: 200, ai_hours: 100 }), o, cfg);
  eq(r.verdict, "PASS", "score < BID_MIN_SCORE force-passed");
  eq(r.value_score, 0, "force-pass zeroes score");
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
  const dup = validateScore(makeScore({ take_upgrades: ["sealed", "sealed"] }), o);
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

// ---------- K. enforceUpgradeCap ----------
{
  const capped = enforceUpgradeCap(["sealed", "sponsored"], 5000, 4500);
  eq(capped.kept.includes("sponsored"), false, "cap cuts sponsored first");
  eq(capped.kept.includes("sealed"), true, "cap keeps sealed");
}

// ---------- L. fetchProjectClient (mock fetch) ----------
async function testClient() {
  const realFetch = globalThis.fetch;
  const client = {
    registration_unixtime: 1700000000,
    address: { city: "Adana", country: "Turkey", country_code: "tr" },
    rating: { average: 4.8, review_count: 12 },
    verification: { payment_verified: true, email_verified: true, profile_complete: false, phone_verified: true, deposit_made: true },
  };
  const env = {} as any;

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: "success", result: { client, other_employer_jobs: [{}, {}] } }), { status: 200 })) as any;
  const full = await fetchProjectClient(env, "https://www.freelancer.com/projects/a/b");
  eq(full && full.payment_verified, true, "client: payment_verified parsed");
  eq(full && full.deposit_made, true, "client: deposit_made parsed");
  eq(full && full.rating, 4.8, "client: rating parsed");
  eq(full && full.review_count, 12, "client: review_count parsed");
  eq(full && full.open_projects, 2, "client: open_projects = other_employer_jobs length");
  eq(full && full.country, "Turkey", "client: country parsed");

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: "success", result: { client: { verification: { payment_verified: false } } } }), { status: 200 })) as any;
  const sparse = await fetchProjectClient(env, "a/b");
  eq(sparse && sparse.payment_verified, false, "client: explicit false kept");
  eq(sparse && sparse.deposit_made, null, "client: missing field null");

  globalThis.fetch = (async () => new Response(JSON.stringify({ status: "success", result: {} }), { status: 200 })) as any;
  eq(await fetchProjectClient(env, "a/b"), null, "client: no client block -> null");

  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as any;
  eq(await fetchProjectClient(env, "a/b"), null, "client: 404 -> null");

  globalThis.fetch = (async () => { throw new Error("net down"); }) as any;
  eq(await fetchProjectClient(env, "a/b"), null, "client: network error -> null");

  globalThis.fetch = realFetch;
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
  } as any;
  const item = (id: number, title: string, description: string) => ({ id, user_id: 94242579, title, description });

  // 1) полный ответ: portfolios + username
  globalThis.fetch = (async (url: string) => {
    if (url.includes("/portfolios/")) {
      return new Response(
        JSON.stringify({ status: "success", result: { portfolios: { 94242579: [item(1, "Proj A", "desc A"), item(2, "Proj B", "x".repeat(900))] } } }),
        { status: 200 });
    }
    return new Response(JSON.stringify({ status: "success", result: { username: "gleb7499" } }), { status: 200 });
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

// ---------- K2. пре-гейт до LLM ----------
{
  const base = makeOrder({});
  eq(preBidRejectReason(base), null, "pregate: clean order passes");
  eq(
    preBidRejectReason(makeOrder({ upgrades: { fulltime: false, featured: false, sealed: false, NDA: false, urgent: false, recruiter: true } })),
    "rej:recruiter",
    "pregate: recruiter rejected",
  );
  eq(
    preBidRejectReason(makeOrder({ is_seller_kyc_required: true })),
    "rej:kyc-required",
    "pregate: kyc required rejected",
  );
  eq(
    preBidRejectReason(makeOrder({ client: { payment_verified: null, deposit_made: null, email_verified: null, phone_verified: null, rating: null, review_count: null, registered_ts: null, country: null, open_projects: null, skill_ids: [9, CRYPTO_SKILL_ID] } })),
    "rej:crypto-verified",
    "pregate: crypto skill rejected",
  );
  eq(
    preBidRejectReason(makeOrder({ client: { payment_verified: true, deposit_made: null, email_verified: null, phone_verified: null, rating: null, review_count: null, registered_ts: null, country: null, open_projects: null, skill_ids: [9, 1031] } })),
    null,
    "pregate: non-crypto skills pass",
  );
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

// ---------- запуск ----------
(async () => {
  await testClient();
  await testPortfolio();
  await testArtifacts();
  testCards();
  console.log(`\nPASS: ${pass}, FAIL: ${fail}`);
  if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures) console.log(" -", f);
    process.exit(1);
  }
  console.log("ALL GREEN");
})();
