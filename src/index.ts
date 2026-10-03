import type { Env, Order, ScoreResult, UpgradeId } from "./types";
import { getConfig, type Config } from "./config";
import { fetchProjectsByIds, fetchOwnerInfo } from "./enrich";
import { filterNew, markAlertSeen, markRejected, seenStats24h } from "./service";
import { fetchAlertLeads } from "./sources/freelancer-alerts";
import { log, logImportant, logError, heartbeat, readRing, flushLogBuffer } from "./logger";
import {
  scoreOrder,
  buildBidMessages,
  generateBidText,
  KimiError,
} from "./kimi";
import { formatOrderCard, sendTelegram, alert, setWebhook } from "./telegram";
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

const AUTH_ALERT_KEY = "alerts:auth_alerted";
const AUTH_ALERT_TTL_SEC = 3600;
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

  const ordersToScore: Order[] = [];

  // --- Единственный канал: saved search alerts ---
  try {
    const alerts = await fetchAlertLeads(env);
    if (alerts.authFailed) {
      log("alerts.authFailed", {});
      await sendAuthAlertOnce(
        env,
        AUTH_ALERT_KEY,
        AUTH_ALERT_TTL_SEC,
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
        // Единственный статический гейт: bids > 5 (source alert внутри).
        const freshAlerts = await markAlertSeen(env, alertSeen);
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

  if (ordersToScore.length === 0) {
    await finishTick(env, stats, startedAt);
    await flushLogBuffer(env);
    return stats;
  }

  // Enrich: информация о заказчике уходит в JSON скорингу.
  for (const order of ordersToScore) {
    if (order.owner_id === null) continue;
    try {
      order.owner = await fetchOwnerInfo(env, order.owner_id);
    } catch (e) {
      order.owner = null;
      console.warn("fetchOwnerInfo failed:", { id: order.id, err: String(e) });
    }
  }

  // Гейт bids-баланса (getBidLimit API, fallback — D1-леджер).
  let bidsBalance: number | null = null;
  try {
    const b = await getBidsBalance(env);
    bidsBalance = b.balance;
  } catch (e) {
    console.warn("getBidsBalance failed:", String(e));
  }

  if (bidsBalance === 0) {
    log("tick.idle-no-bids", { pending: ordersToScore.length });
    await markRejected(env, ordersToScore, "rej:no-bids");
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

  let llmBroken = false;

  for (const order of ordersToScore) {
    if (llmBroken) break;

    try {
      let score = await scoreOrder(env, order);

      if (score === null) {
        await logError(env, "order.error", { id: order.id, err: "scoring-parse-failed" });
        continue;
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
        stats.llmPass += 1;
        continue;
      }

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
      stats.bidCards += 1;
      await logImportant(env, "order.notified", {
        id: order.id,
        title: order.title.slice(0, 80),
        bid: score.bid_amount,
        net: score.net_amount,
        placed: bidResult.placed,
      });
    } catch (e) {
      if (e instanceof KimiError && e.status === 429) {
        llmBroken = true;
        await logError(env, "order.error", { id: order.id, err: "kimi-429" });
        continue;
      }
      console.error(`order ${order.id} processing failed:`, e);
      await logError(env, "order.error", { id: order.id, err: String(e).slice(0, 200) });
    }
  }

  stats.scored = stats.llmPass + stats.bidCards;
  await finishTick(env, stats, startedAt);
  await flushLogBuffer(env);
  return stats;
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
    // Fallback: берём первый свежий алерт, если он есть.
    const alerts = await fetchAlertLeads(env);
    if (alerts.leads.length > 0) {
      const orders = await fetchProjectsByIds(env, [alerts.leads[0].projectId]);
      order = orders[0] ?? null;
    }
    if (!order) {
      return jsonResponse({ error: "no live orders (alerts empty)" }, 404);
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
  };
}

// Команды оператора из Telegram. Принимаем только от TELEGRAM_CHAT_ID.
async function handleTgCommand(env: Env, text: string): Promise<void> {
  const trimmed = text.trim();

  if (trimmed.startsWith("/mode")) {
    const arg = trimmed.slice("/mode".length).trim();
    if (arg === "test" || arg === "live" || arg === "off") {
      await setMode(env, arg);
      await sendTelegram(env, `режим: ${arg}`);
    } else {
      await sendTelegram(env, `режим: допустимы test|live|off, получено "${arg || "∅"}"`);
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
        handleTgCommand(env, text).catch((e) => console.error("tg.command failed:", e)),
      );
    } else {
      console.warn("tg.webhook: ignored foreign chat", chatId);
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
    ctx.waitUntil(
      runTick(env).catch((e) => console.error("tick failed", e)),
    );
  },
} satisfies ExportedHandler<Env>;
