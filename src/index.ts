import type { Env, Order, ScoreResult, UpgradeId } from "./types";
import { getConfig, type Config } from "./config";
import { fetchProjectClient } from "./enrich";
import { filterNew, markAlertSeen, seenStats24h } from "./service";
import { fetchActiveOrders } from "./sources/freelancer-active";
import { log, logImportant, logError, heartbeat, readRing, flushLogBuffer } from "./logger";
import {
  scoreOrder,
  buildBidMessages,
  generateBidText,
  KimiError,
} from "./kimi";
import { formatOrderCard, formatPassCard, formatRejectCard, sendTelegram, alert, setWebhook, answerCallbackQuery, editMessage, deleteMessage } from "./telegram";
import { enforceUpgradeCap, priceUpgrades } from "./upgrades";
import { placeBid } from "./bidder";
import { getMode, setMode, type Mode } from "./mode";
import { getBidsBalance } from "./bids-balance";

interface TickStats {
  mode: Mode;
  alertsFetched: number;
  alertsFresh: number;
  scored: number;
  llmPass: number;
  bidCards: number;
  errors: string[];
}

const BIDS_UNSET_ALERT_KEY = "bids:unset-alerted";

async function sendAuthAlertOnce(env: Env, key: string, ttlSec: number, message: string): Promise<void> {
  const already = await env.ORDERS_KV.get(key);
  if (already !== null) return;
  await env.ORDERS_KV.put(key, String(Date.now()), { expirationTtl: ttlSec });
  await alert(env, message);
}

// Потолок weekly limit для hourly: LLM может только снизить лимит.
function clampWeeklyLimit(score: ScoreResult, cfg: Config): void {
  if (score.weekly_limit_hours === null) return;
  const cap = Math.min(cfg.weeklyLimitHours, 40);
  score.weekly_limit_hours = Math.min(score.weekly_limit_hours, cap);
}

export async function runTick(env: Env, trigger: "cron" | "manual" = "cron"): Promise<TickStats> {
  const mode = await getMode(env);
  const stats: TickStats = {
    mode,
    alertsFetched: 0,
    alertsFresh: 0,
    scored: 0,
    llmPass: 0,
    bidCards: 0,
    errors: [],
  };

  // Режим off — ничего не делаем вообще.
  if (mode === "off") {
    log("tick.off", { trigger });
    await flushLogBuffer(env);
    return stats;
  }

  const cfg = getConfig(env);
  const startedAt = Date.now();
  log("tick.start", { trigger, mode });

  // Гейт bids-баланса — ДО опроса заказов: при balance = 0 система в idle
  // (нет ни опроса API, ни LLM) до восстановления хотя бы одного bid.
  // Заказы за время простоя не теряются окончательно: курсор не двигается,
  // при возобновлении докрутимся по свежему окну выдачи.
  let bidsBalance: number | null = null;
  try {
    const b = await getBidsBalance(env);
    bidsBalance = b.balance;
  } catch (e) {
    console.warn("getBidsBalance failed:", String(e));
  }

  if (bidsBalance === 0) {
    log("tick.idle-no-bids", {});
    if (mode === "test") {
      await alert(env, "bids = 0 — idle: опрос и LLM остановлены до восстановления bid");
    }
    await finishTick(env, stats, startedAt);
    await flushLogBuffer(env);
    return stats;
  }

  if (bidsBalance === null) {
    // Баланс не прочитался (API getBidLimit недоступен и леджер пуст) —
    // работаем без поднятия планки, но алертим (не чаще раза в сутки).
    await sendAuthAlertOnce(
      env,
      BIDS_UNSET_ALERT_KEY,
      86400,
      "Баланс bids не читается (getBidLimit недоступен)",
    );
  }

  const ordersToScore: Order[] = [];

  // --- Единственный канал: официальный публичный API projects/active ---
  try {
    const active = await fetchActiveOrders(env);
    if (active.error !== null) {
      stats.errors.push(active.error);
      await logError(env, "active.error", { message: active.error });
    } else if (!active.skipped && active.orders.length > 0) {
      stats.alertsFetched = active.orders.length;
      log("active.fetched", { count: active.orders.length });
      const fresh = await filterNew(env, active.orders);
      // Единственный статический гейт: bids > 10.
      const kept = await markAlertSeen(env, fresh, "active");
      stats.alertsFresh = kept.length;
      log("active.fresh", { fresh: kept.length });
      ordersToScore.push(...kept);
      // Test-режим: уведомляем и об отклонённых гейтом (причина — bids>10).
      if (mode === "test") {
        const keptIds = new Set(kept.map((o) => o.id));
        for (const order of fresh) {
          if (keptIds.has(order.id)) continue;
          await sendTelegram(env, `[TEST] гейт bids>10\n\n${formatRejectCard(order, `уже ${order.bids} откликов (лимит ≤10 до LLM)`)}`);
        }
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    stats.errors.push(message);
    await logError(env, "active.error", { message });
  }

  if (ordersToScore.length === 0) {
    await finishTick(env, stats, startedAt);
    await flushLogBuffer(env);
    return stats;
  }

  // Enrich: данные заказчика (verification, рейтинг работодателя, открытые
  // заказы) с открытой точки projects/seo уходят в JSON скорингу.
  for (const order of ordersToScore) {
    try {
      order.client = await fetchProjectClient(env, order.url);
    } catch (e) {
      order.client = null;
      console.warn("fetchProjectClient failed:", { id: order.id, err: String(e) });
    }
  }

  // Параллельная обработка: каждый заказ — свой "поток" (async-задача) с полным
  // циклом score → bidText → placeBid → карточка. Пул лимитирует одновременные
  // LLM-вызовы (3) чтобы не провоцировать Kimi 429.
  const bidCtx: { reserved: number } = { reserved: 0 };

  const results = await runWithConcurrency(ordersToScore, 3, async (order) => {
    const outcome = await processOrder(env, order, cfg, mode, bidsBalance, bidCtx);
    if (outcome === "pass") stats.llmPass += 1;
    else if (outcome === "bid") stats.bidCards += 1;
  });
  void results;

  stats.scored = stats.llmPass + stats.bidCards;
  await finishTick(env, stats, startedAt);
  await flushLogBuffer(env);
  return stats;
}

type OrderOutcome = "bid" | "pass" | "error";

interface BidReservation {
  reserved: number;
}

async function processOrder(
  env: Env,
  order: Order,
  cfg: Config,
  mode: Mode,
  bidsBalance: number | null,
  bidCtx: BidReservation,
): Promise<OrderOutcome> {
  try {
    const score = await scoreOrder(env, order);

    if (score === null) {
      await logError(env, "order.error", { id: order.id, err: "scoring-parse-failed" });
      return "error";
    }

    clampWeeklyLimit(score, cfg);

    await logImportant(env, "llm.verdict", {
      id: order.id,
      verdict: score.verdict,
      reason: score.reason,
      bid_amount: score.bid_amount,
      net_amount: score.net_amount,
      value_score: score.value_score,
    });

    if (score.verdict === "PASS") {
      // Test-режим: PASS тоже уведомляем — для анализа качества скоринга.
      if (mode === "test") {
        await sendTelegram(env, `[TEST] PASS\n\n${formatPassCard(order, score)}`);
      }
      return "pass";
    }

    // Общий bids-баланс: защита от перерасхода внутри батча.
    // bidsBalance — снимок до пула; reserved — BID'ы этого тика.
    if (bidsBalance !== null && bidsBalance - bidCtx.reserved <= 0) {
      bidCtx.reserved += 1;
      await sendTelegram(env, `⚠️ Отклик НЕ отправлен: bids exhausted in tick\n\n${formatOrderCard(order, score, null, [])}`);
      await logImportant(env, "order.notified", {
        id: order.id,
        title: order.title.slice(0, 80),
        placed: false,
        reason: "bids-exhausted-in-tick",
      });
      return "bid";
    }
    bidCtx.reserved += 1;

    const cap = enforceUpgradeCap(score.take_upgrades, score.bid_amount, score.net_amount);
    let removedUpgrades: UpgradeId[] = [];
    if (cap.removed.length > 0) {
      score.take_upgrades = cap.kept;
      removedUpgrades = cap.removed;
    }

    let bidText: string | null = null;
    try {
      bidText = await generateBidText(env, buildBidMessages(order, score));
    } catch (e) {
      console.error("generateBidText failed:", e);
    }

    const bidResult = await placeBid(env, order, score, bidText);

    const card = formatOrderCard(order, score, bidText, removedUpgrades);
    let header: string;
    if (mode === "test") {
      header = `[TEST] ставка НЕ отправлена`;
    } else if (bidResult.placed) {
      const upgradesPart =
        score.take_upgrades.length > 0 ? score.take_upgrades.join(", ") : "без апгрейдов";
      header = `✅ Отклик отправлен: $${score.bid_amount}, апгрейды: ${upgradesPart}`;
    } else {
      header = `⚠️ Отклик НЕ отправлен: ${bidResult.reason ?? "unknown"}`;
    }
    await sendTelegram(env, `${header}\n\n${card}`);
    await logImportant(env, "order.notified", {
      id: order.id,
      title: order.title.slice(0, 80),
      bid: score.bid_amount,
      net: score.net_amount,
      placed: bidResult.placed,
    });
    return "bid";
  } catch (e) {
    // 429 и прочие — падает только этот заказ, остальные в пуле продолжают.
    console.error(`order ${order.id} processing failed:`, e);
    await logError(env, "order.error", {
      id: order.id,
      err: e instanceof KimiError && e.status === 429 ? "kimi-429" : String(e).slice(0, 200),
    });
    return "error";
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function finishTick(env: Env, stats: TickStats, startedAt: number): Promise<void> {
  const durationMs = Date.now() - startedAt;
  log("tick.done", { stats, durationMs });
  if (stats.alertsFresh > 0 || stats.bidCards > 0 || stats.errors.length > 0) {
    await logImportant(env, "tick.done-nonquiet", {
      alertsFresh: stats.alertsFresh,
      bidCards: stats.bidCards,
      errors: stats.errors.length,
      durationMs,
    });
  } else {
    await heartbeat(env, { durationMs });
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isAuthorized(request: Request, env: Env): boolean {
  return request.headers.get("X-Admin-Token") === env.ADMIN_TOKEN;
}

async function handleKimiModels(env: Env): Promise<Response> {
  const cfg = getConfig(env);
  try {
    const res = await fetch(`${cfg.kimiBase}/models`, {
      headers: { Authorization: `Bearer ${env.KIMI_API_KEY}` },
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return jsonResponse({ error: String(e) }, 502);
  }
}

async function handleTestScore(request: Request, env: Env): Promise<Response> {
  let order: Order | null = null;

  const raw = await request.text();
  if (raw.trim() !== "" && raw.trim() !== "{}") {
    try {
      order = JSON.parse(raw) as Order;
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
  } else {
    // Fallback: берём самый свежий заказ из официального active-канала.
    const active = await fetchActiveOrders(env);
    if (active.orders.length > 0) {
      order = active.orders[0];
    }
    if (!order) {
      return jsonResponse({ error: "no live orders (active feed empty)" }, 404);
    }
  }

  try {
    let score = await scoreOrder(env, order);
    if (score === null) {
      return jsonResponse({ order, score: null, reason: "scoring parse failed" });
    }
    clampWeeklyLimit(score, getConfig(env));
    let removedUpgrades: UpgradeId[] = [];
    if (score.verdict === "BID") {
      const cap = enforceUpgradeCap(score.take_upgrades, score.bid_amount, score.net_amount);
      if (cap.removed.length > 0) {
        score.take_upgrades = cap.kept;
        removedUpgrades = cap.removed;
      }
    }
    let bidText: string | null = null;
    if (score.verdict === "BID") {
      try {
        bidText = await generateBidText(env, buildBidMessages(order, score));
      } catch (e) {
        bidText = null;
        console.error("generateBidText failed:", e);
      }
    }
    const response: Record<string, unknown> = {
      order,
      score,
      bidText,
      upgradePrices: priceUpgrades(score.take_upgrades, score.bid_amount),
    };
    if (removedUpgrades.length > 0) response.removedUpgrades = removedUpgrades;
    return jsonResponse(response);
  } catch (e) {
    if (e instanceof KimiError) {
      return jsonResponse({ error: e.message, status: e.status }, 502);
    }
    throw e;
  }
}

interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string };
    text?: string;
    message_id?: number;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id?: number | string }; message_id?: number };
  };
}

const MODE_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🧪 test", callback_data: "mode:test" },
      { text: "🚀 live", callback_data: "mode:live" },
      { text: "⏸ off", callback_data: "mode:off" },
    ],
  ],
};

// Команды оператора из Telegram. Принимаем только от TELEGRAM_CHAT_ID.
async function handleTgCommand(
  env: Env,
  text: string,
  execCtx: ExecutionContext,
  msg?: { chatId: number | string; messageId?: number },
): Promise<void> {
  const trimmed = text.trim();

  if (trimmed.startsWith("/mode")) {
    const arg = trimmed.slice("/mode".length).trim();
    if (arg === "test" || arg === "live" || arg === "off") {
      await setMode(env, arg);
      await sendTelegram(env, `режим: ${arg}`);
    } else {
      // Без аргумента — интерактивный выбор кнопками; эхо команды удаляем.
      await sendTelegram(env, "Выбери режим:", MODE_KEYBOARD);
      if (msg?.messageId !== undefined) {
        execCtx.waitUntil(
          deleteMessage(env, msg.chatId, msg.messageId).catch(() => undefined),
        );
      }
    }
    return;
  }

  if (trimmed === "/status") {
    const mode = await getMode(env);
    const balance = await getBidsBalance(env);
    const stats = await seenStats24h(env);
    const lines = stats.map((s) => `  ${s.status}/${s.source}: ${s.count}`);
    const balanceLine =
      balance.balance === null
        ? "баланс bids: неизвестен (API недоступен)"
        : `баланс bids: ${balance.balance} [${balance.source}]` +
          (balance.nextBidInMinutes !== null ? ` (след. +1 через ${balance.nextBidInMinutes} мин)` : "");
    log("tg.status", { mode, balance: balance.balance, source: balance.source });
    await sendTelegram(
      env,
      [`режим: ${mode}`, balanceLine, `seen за 24ч:`, ...lines].join("\n"),
    );
    return;
  }
}

// Telegram ретраит апдейт, если не получил 200 быстро — отвечаем сразу,
// команда обрабатывается в фоне (иначе дубли сообщений).
async function handleTgWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Not Found", { status: 404 });
  }
  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("ok");
  }
  const message = update.message;
  const chatId = message?.chat?.id;
  if (typeof message?.text === "string" && chatId !== undefined) {
    if (String(chatId) === env.TELEGRAM_CHAT_ID) {
      const text = message.text;
      log("tg.command", { text });
      ctx.waitUntil(
        handleTgCommand(env, text, ctx, { chatId, messageId: message.message_id }).catch(
          (e) => console.error("tg.command failed:", e),
        ),
      );
    } else {
      console.warn("tg.webhook: ignored foreign chat", chatId);
    }
  }

  const callback = update.callback_query;
  if (callback?.id && typeof callback.data === "string") {
    const cbChatId = callback.message?.chat?.id;
    if (String(cbChatId) === env.TELEGRAM_CHAT_ID && callback.data.startsWith("mode:")) {
      const selected = callback.data.slice("mode:".length);
      log("tg.callback", { data: callback.data });
      ctx.waitUntil(
        (async () => {
          if (selected === "test" || selected === "live" || selected === "off") {
            await setMode(env, selected);
            await answerCallbackQuery(env, callback.id);
            // Вместо нового сообщения — заменяем само «Выбери режим:» и
            // убираем клавиатуру. Сообщение больше не засоряет чат.
            const cbMessageId = callback.message?.message_id;
            if (cbChatId !== undefined && typeof cbMessageId === "number") {
              await editMessage(env, cbChatId, cbMessageId, `режим: ${selected} ✅`);
            } else {
              await sendTelegram(env, `режим: ${selected}`);
            }
          } else {
            await answerCallbackQuery(env, callback.id, "неизвестный режим");
          }
        })().catch((e) => console.error("tg.callback failed:", e)),
      );
    }
  }
  return new Response("ok");
}

async function handleSetWebhook(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  const webhookUrl = `${origin}/tg-webhook/${env.ADMIN_TOKEN}`;
  const result = await setWebhook(env, webhookUrl);
  return jsonResponse({ webhookUrl, result });
}

async function handleFlAuth(request: Request, env: Env): Promise<Response> {
  const AUTH_KV_KEY = "fl:auth";
  if (request.method === "GET") {
    const raw = await env.ORDERS_KV.get(AUTH_KV_KEY);
    return jsonResponse({ overrideSet: raw !== null });
  }
  if (request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const { userId, hash } = (body ?? {}) as { userId?: unknown; hash?: unknown };
    if (typeof userId !== "string" || userId === "" || typeof hash !== "string" || hash === "") {
      return jsonResponse({ error: "body must be {userId: string, hash: string}" }, 400);
    }
    await env.ORDERS_KV.put(AUTH_KV_KEY, JSON.stringify({ userId, hash }));
    log("fl.auth.override-set", {});
    return jsonResponse({ ok: true });
  }
  return new Response("Not Found", { status: 404 });
}

// Durable Object — быстрый цикл тиков: cron в Workers не умеет чаще минуты,
// поэтому runTick крутится на alarm-цепочке каждые TICK_INTERVAL_MS.
// DO однопоточный: тики не перекрываются, следующий аларм ставится
// по завершении предыдущего. Cron (1/мин) — сторож: будит DO, если цепочка
// прервалась (деплой, ошибка инфраструктуры).
const TICK_INTERVAL_MS = 10_000;

export class TickScheduler {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(): Promise<Response> {
    // Сторож: ставим аларм только если его нет (не перезапускаем цепочку).
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now());
    }
    return new Response("ok");
  }

  async alarm(): Promise<void> {
    try {
      await runTick(this.env);
    } catch (e) {
      console.error("tick failed", e);
    } finally {
      // Цепочка не должна прерваться даже при исключении.
      await this.state.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
    }
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    // Webhook-путь авторизован токеном в URL, не заголовком.
    if (url.pathname === `/tg-webhook/${env.ADMIN_TOKEN}`) {
      return await handleTgWebhook(request, env, ctx);
    }

    if (!isAuthorized(request, env)) {
      return new Response("Not Found", { status: 404 });
    }

    try {
      if (request.method === "GET" && url.pathname === "/test/kimi-models") {
        return await handleKimiModels(env);
      }
      if (request.method === "POST" && url.pathname === "/test/score") {
        return await handleTestScore(request, env);
      }
      if (request.method === "POST" && url.pathname === "/test/tick") {
        const stats = await runTick(env, "manual");
        return jsonResponse(stats);
      }
      if (request.method === "POST" && url.pathname === "/test/set-webhook") {
        return await handleSetWebhook(request, env);
      }
      if (request.method === "GET" && url.pathname === "/test/logs") {
        return jsonResponse(await readRing(env));
      }
      if (request.method === "GET" && url.pathname === "/test/bids-balance") {
        return jsonResponse(await getBidsBalance(env));
      }
      if (url.pathname === "/admin/fl-auth") {
        return await handleFlAuth(request, env);
      }
    } catch (e) {
      return jsonResponse({ error: String(e) }, 500);
    }

    return new Response("Not Found", { status: 404 });
  },

  scheduled(event, env, ctx): void {
    // Watchdog: будим DO (если alarm-цепочка жива — no-op).
    const stub = env.TICK_SCHEDULER.get(env.TICK_SCHEDULER.idFromName("main"));
    ctx.waitUntil(stub.fetch("https://do.internal/wake").catch((e) => console.error("do wake failed", e)));
  },
} satisfies ExportedHandler<Env>;
