import type { Env, Order, ScoreResult, UpgradeId } from "./types";
import { getConfig, type Config } from "./config";
import { NICHES } from "./niches";
import { fetchAllNiches, fetchProjectsByIds } from "./parser";
import { processOrders, pickNiches, filterNew, classifyCompetition, markAlertSeen } from "./service";
import { fetchAlertLeads } from "./sources/freelancer-alerts";
import { log, logImportant, logError, heartbeat, readRing, flushLogBuffer } from "./logger";
import {
  scoreOrder,
  buildBidMessages,
  generateBidText,
  KimiError,
} from "./kimi";
import {
  formatOrderCard,
  formatRawCard,
  sendTelegram,
  alert,
  pingUnappliedBids,
  saveBidCard,
  answerCallbackQuery,
  setWebhook,
  appliedKey,
  bidCardKey,
} from "./telegram";
import { enforceUpgradeCap, priceUpgrades } from "./upgrades";
import { placeBid } from "./bidder";

interface TickStats {
  niches: number;
  fetched: number;
  seen: number;
  rejected: number;
  fresh: number;
  notified: number;
  llmPass: number;
  alertsFetched: number;
  alertsFresh: number;
  errors: string[];
}

const AUTH_ALERT_KEY = "alerts:auth_alerted";
const AUTH_ALERT_TTL_SEC = 3600;

async function sendAuthAlertOnce(env: Env, message: string): Promise<void> {
  const already = await env.ORDERS_KV.get(AUTH_ALERT_KEY);
  if (already !== null) return;
  await env.ORDERS_KV.put(AUTH_ALERT_KEY, String(Date.now()), {
    expirationTtl: AUTH_ALERT_TTL_SEC,
  });
  await alert(env, message);
}

// Потолок weekly limit для hourly: LLM может только снизить лимит.
function clampWeeklyLimit(score: ScoreResult, cfg: Config): void {
  if (score.weekly_limit_hours === null) return;
  const cap = Math.min(cfg.weeklyLimitHours, 40);
  score.weekly_limit_hours = Math.min(score.weekly_limit_hours, cap);
}

export async function runTick(env: Env, trigger: "cron" | "manual" = "cron"): Promise<TickStats> {
  const cfg = getConfig(env);
  const startedAt = Date.now();
  log("tick.start", { trigger });
  const stats: TickStats = {
    niches: 0,
    fetched: 0,
    seen: 0,
    rejected: 0,
    fresh: 0,
    notified: 0,
    llmPass: 0,
    alertsFetched: 0,
    alertsFresh: 0,
    errors: [],
  };

  // Пинг неподтверждённых BID — раз в 15 минут: list-операции в KV
  // лимитированы (free tier — 1000/сутки), а чаще проверять не нужно
  // (порог пинга — 25 минут). Не пингуем сразу после старта тика?
  // Порядок не важен: пинг отдельный от обработки заказов.
  try {
    const PING_INTERVAL_MS = 15 * 60 * 1000;
    const raw = await env.ORDERS_KV.get("ping:last");
    const last = raw === null ? 0 : Number(raw);
    if (!Number.isFinite(last) || Date.now() - last >= PING_INTERVAL_MS) {
      await env.ORDERS_KV.put("ping:last", String(Date.now()), { expirationTtl: 86400 });
      await pingUnappliedBids(env);
    }
  } catch (e) {
    console.error("pingUnappliedBids failed:", e);
  }

  const ordersToScore: Order[] = [];

  // --- Alert-канал (saved search alerts) — независим от search, ошибки не роняют тик ---
  try {
    const alerts = await fetchAlertLeads(env);
    if (alerts.authFailed) {
      log("alerts.authFailed", {});
      await sendAuthAlertOnce(
        env,
        "Протухла сессия Freelancer (alerts), обнови куки через /admin/fl-auth",
      );
    } else if (alerts.error !== null) {
      stats.errors.push(alerts.error);
      await logError(env, "alerts.error", { message: alerts.error });
    } else if (alerts.leads.length > 0) {
      stats.alertsFetched = alerts.leads.length;
      log("alerts.fetched", { count: alerts.leads.length });
      try {
        const alertOrders = await fetchProjectsByIds(
          env,
          alerts.leads.map((l) => l.projectId),
        );
        const alertSeen = await filterNew(env, alertOrders);
        // Freelancer уже отфильтровал по сохранённому поиску —
        // без staticReject и competition-отсева (кроме bids > 50 внутри markAlertSeen).
        const freshAlerts = await markAlertSeen(env, alertSeen);
        for (const order of freshAlerts) {
          order.competition = classifyCompetition(order.bids);
        }
        stats.alertsFresh = freshAlerts.length;
        log("alerts.fresh", { fresh: freshAlerts.length });
        ordersToScore.push(...freshAlerts);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        stats.errors.push(message);
        await logError(env, "alerts.error", { message });
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    stats.errors.push(message);
    await logError(env, "alerts.error", { message });
  }

  const niches = pickNiches(NICHES, cfg.nichesPerTick);
  stats.niches = niches.length;
  log("niches.picked", { ids: niches.map((n) => n.id) });

  const { orders, errors, perNiche } = await fetchAllNiches(env, niches);
  stats.fetched = orders.length;
  stats.errors = errors;
  log("parser.done", { perNiche, total: orders.length, errors: errors.length });
  for (const message of errors) {
    await logError(env, "parser.error", { message });
  }

  if (orders.length === 0) {
    if (errors.length > 0) {
      await alert(env, `Freelancer API errors: ${errors.join(" | ")}`);
    }
  } else {
    const { fresh, rejectedCount, seenCount, byReason } = await processOrders(env, orders);
    stats.seen = seenCount;
    stats.rejected = rejectedCount;
    stats.fresh = fresh.length;
    log("dedup.done", { fetched: orders.length, fresh: fresh.length, seen: seenCount });
    log("filters.done", { rejected: rejectedCount, byReason });
    ordersToScore.push(...fresh);
  }

  if (ordersToScore.length === 0) {
    await finishTick(env, stats, startedAt);
    return stats;
  }

  let llmBroken = false;

  for (const order of ordersToScore) {
    if (llmBroken) {
      const card = formatRawCard(order, "LLM недоступен (429) — сырая карточка");
      await sendTelegram(env, card);
      continue;
    }

    try {
      let score = await scoreOrder(env, order);

      if (score === null) {
        const card = formatRawCard(order, "скоринг не распарсился — сырая карточка");
        await sendTelegram(env, card);
        continue;
      }

      clampWeeklyLimit(score, cfg);

      await logImportant(env, "llm.verdict", {
        id: order.id,
        verdict: score.verdict,
        reason: score.reason,
        bid_amount: score.bid_amount,
        net_amount: score.net_amount,
      });

      if (score.verdict === "PASS") {
        stats.llmPass += 1;
        // ВРЕМЕННО (debug): присылаем PASS-карточки для ручной проверки решений LLM.
        // Удалить после отладки — вместе с этим блоком и пометкой в AGENT.md.
        try {
          const debugCard = formatOrderCard(order, score, null, []);
          await sendTelegram(env, `🔍 DEBUG PASS\n${debugCard}`);
        } catch (e) {
          console.error("debug PASS card failed:", e);
        }
        continue;
      }

      let removedUpgrades: UpgradeId[] = [];
      if (score.verdict === "BID") {
        const cap = enforceUpgradeCap(score.take_upgrades, score.bid_amount, score.net_amount);
        if (cap.removed.length > 0) {
          score.take_upgrades = cap.kept;
          removedUpgrades = cap.removed;
        }
      }

      let bidText: string | null = null;
      try {
        bidText = await generateBidText(env, buildBidMessages(order, score));
      } catch (e) {
        console.error("generateBidText failed:", e);
      }

      const card = formatOrderCard(order, score, bidText, removedUpgrades);
      const keyboard =
        score.verdict === "BID"
          ? { inline_keyboard: [[{ text: "Откликнулся ✅", callback_data: `applied:${order.id}` }]] }
          : undefined;
      await sendTelegram(env, card, keyboard);
      if (score.verdict === "BID") {
        await saveBidCard(env, order);
        try {
          await placeBid(env, order, score, bidText);
        } catch (e) {
          console.error("placeBid failed:", e);
        }
      }
      stats.notified += 1;
      await logImportant(env, "order.notified", {
        id: order.id,
        title: order.title.slice(0, 80),
        bid: score.bid_amount,
        net: score.net_amount,
      });
    } catch (e) {
      if (e instanceof KimiError && e.status === 429) {
        await alert(env, "Kimi 429 rate window");
        llmBroken = true;
        await logError(env, "order.error", { id: order.id, err: "kimi-429" });
        const card = formatRawCard(order, "LLM недоступен (429) — сырая карточка");
        await sendTelegram(env, card);
        continue;
      }
      console.error(`order ${order.id} processing failed:`, e);
      await logError(env, "order.error", { id: order.id, err: String(e).slice(0, 200) });
      try {
        const card = formatRawCard(order, `ошибка обработки: ${String(e)}`);
        await sendTelegram(env, card);
      } catch (sendErr) {
        console.error("raw card send failed:", sendErr);
      }
    }
  }

  await finishTick(env, stats, startedAt);
  await flushLogBuffer(env);
  return stats;
}

async function finishTick(env: Env, stats: TickStats, startedAt: number): Promise<void> {
  const durationMs = Date.now() - startedAt;
  log("tick.done", { stats, durationMs });
  if (stats.fresh > 0 || stats.notified > 0 || stats.llmPass > 0 || stats.errors.length > 0) {
    await logImportant(env, "tick.done-nonquiet", {
      fresh: stats.fresh,
      notified: stats.notified,
      llmPass: stats.llmPass,
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
    const { orders, errors } = await fetchAllNiches(env, [NICHES[0]]);
    if (orders.length === 0) {
      return jsonResponse(
        { error: "no live orders", parserErrors: errors },
        404,
      );
    }
    order = orders[0];
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

interface TelegramCallbackUpdate {
  callback_query?: {
    id: string;
    data?: string;
  };
}

async function handleTgWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Not Found", { status: 404 });
  }
  let update: TelegramCallbackUpdate;
  try {
    update = (await request.json()) as TelegramCallbackUpdate;
  } catch {
    return new Response("ok");
  }
  const callback = update.callback_query;
  if (callback?.id) {
    if (typeof callback.data === "string" && callback.data.startsWith("applied:")) {
      const id = Number(callback.data.slice("applied:".length));
      if (Number.isFinite(id)) {
        // Идемпотентно: повторное нажатие перезаписывает timestamp.
        await env.ORDERS_KV.put(appliedKey(id), String(Date.now()), {
          expirationTtl: 86400,
        });
        await env.ORDERS_KV.delete(bidCardKey(id));
        log("tg.applied", { id });
      }
    }
    ctxAnswerCallback(env, callback.id);
  }
  return new Response("ok");
}

function ctxAnswerCallback(env: Env, callbackId: string): void {
  // Ответ Telegram не блокирует обработку апдейта.
  answerCallbackQuery(env, callbackId).catch((e) =>
    console.warn("answerCallbackQuery failed:", e),
  );
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

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    // Webhook-путь авторизован токеном в URL, не заголовком.
    if (url.pathname === `/tg-webhook/${env.ADMIN_TOKEN}`) {
      return await handleTgWebhook(request, env);
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
      if (url.pathname === "/admin/fl-auth") {
        return await handleFlAuth(request, env);
      }
    } catch (e) {
      return jsonResponse({ error: String(e) }, 500);
    }

    return new Response("Not Found", { status: 404 });
  },

  scheduled(event, env, ctx): void {
    ctx.waitUntil(
      runTick(env).catch((e) => console.error("tick failed", e)),
    );
  },
} satisfies ExportedHandler<Env>;
