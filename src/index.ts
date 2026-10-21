import type { Env, Order, UpgradeId } from "./types";
import { getConfig } from "./config";
import { fetchPortfolio } from "./enrich";
import { seenStats24h } from "./service";
import { fetchActiveOrders } from "./sources/freelancer-active";
import { fetchSearchOrders } from "./sources/freelancer-search";
import { getChannels, type ChannelId } from "./channels";
import { fetchProfileMap } from "./profiles";
import { log, readRing } from "./logger";
import {
  scoreOrder,
  buildBidMessages,
  generateBidText,
  KimiError,
} from "./kimi";
import { sendTelegram, setWebhook, setMyCommands, answerCallbackQuery, editMessage, deleteMessage } from "./telegram";
import { enforceUpgradeCap, priceUpgrades } from "./upgrades";
import { checkMilestones } from "./milestones";
import { getMode, setMode } from "./mode";
import { clearAuthInvalid } from "./web-auth";
import { getSchedule, setSchedule, isWithinSchedule, parseScheduleArgs, formatSchedule, applyScheduleDelta, type Schedule } from "./schedule";
import { clampWeeklyLimit, channelRunnerStub, ordersBankStub, bidBudgetStub } from "./durable";

// Durable Objects новой архитектуры каналов (реализация — в durable.ts;
// class_name в wrangler.toml ссылается на эти реэкспорты entrypoint).
export { ChannelRunner, OrdersBank, BidBudget, runOrderPipeline } from "./durable";
// Реэкспорт ради приёмки (scripts/acceptance.ts импортирует из index).
export { runWithConcurrency, bySubmitTsDesc } from "./util";

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
    // Fallback: берём самый свежий заказ из общего feed-канала.
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
        const portfolio = await fetchPortfolio(env).catch(() => null);
        bidText = await generateBidText(env, order, buildBidMessages(order, score, portfolio));
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

// Интерактивная клавиатура графика откликов: сдвиги начала/конца на час,
// три пресета и переключатель окна. Раскладка кнопок зависит от текущего
// состояния (подпись переключателя меняется на противоположную).
function buildScheduleKeyboard(s: Schedule) {
  return {
    inline_keyboard: [
      [
        { text: "➖ Начало", callback_data: "sched:s:-60" },
        { text: "➕ Начало", callback_data: "sched:s:+60" },
      ],
      [
        { text: "➖ Конец", callback_data: "sched:e:-60" },
        { text: "➕ Конец", callback_data: "sched:e:+60" },
      ],
      [
        { text: "🌅 8–20", callback_data: "sched:p:480:1200" },
        { text: "🏙 9–22", callback_data: "sched:p:540:1320" },
        { text: "🌃 10–24", callback_data: "sched:p:600:1440" },
      ],
      [
        s.enabled
          ? { text: "🔕 Выключить окно", callback_data: "sched:t" }
          : { text: "🔔 Включить окно", callback_data: "sched:t" },
      ],
    ],
  };
}

// Подпись сообщения графика: выключенное окно подаём как 24/7 — иначе неясно,
// что «выкл» значит «откликаемся всегда».
function scheduleCaption(s: Schedule): string {
  return s.enabled
    ? `График откликов: ${formatSchedule(s)}`
    : `График откликов: ${formatSchedule(s)} (24/7)`;
}

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

  if (trimmed.startsWith("/schedule")) {
    const arg = trimmed.slice("/schedule".length).trim();
    const sched = await getSchedule(env);
    if (arg === "") {
      // Без аргумента — интерактивная клавиатура; эхо команды удаляем
      // (паттерн как у /mode).
      await sendTelegram(env, scheduleCaption(sched), buildScheduleKeyboard(sched));
      if (msg?.messageId !== undefined) {
        execCtx.waitUntil(
          deleteMessage(env, msg.chatId, msg.messageId).catch(() => undefined),
        );
      }
      return;
    }
    if (arg === "off" || arg === "on") {
      const next = { ...sched, enabled: arg === "on" };
      await setSchedule(env, next);
      await sendTelegram(env, `график откликов: ${formatSchedule(next)} ✅`);
      return;
    }
    const parsed = parseScheduleArgs(arg);
    if (parsed === null) {
      await sendTelegram(env, "ошибка: часы 0-24, начало < конца (например: /schedule 9 22)");
      return;
    }
    const next = { ...parsed, enabled: true };
    await setSchedule(env, next);
    await sendTelegram(env, `график откликов: ${formatSchedule(next)} ✅`);
    return;
  }

  if (trimmed === "/status") {
    const mode = await getMode(env);
    const sched = await getSchedule(env);
    const balance = await bidBudgetStub(env).balanceContext();
    const stats = await seenStats24h(env);
    const lines = stats.map((s) => `  ${s.status}/${s.source}: ${s.count}`);
    const balanceLine =
      balance.balance === null
        ? "баланс bids: неизвестен (API недоступен)"
        : `баланс bids: ${balance.balance}` +
          (balance.nextBidInMinutes !== null ? ` (след. +1 через ${balance.nextBidInMinutes} мин)` : "");
    log("tg.status", { mode, balance: balance.balance });
    await sendTelegram(
      env,
      [`режим: ${mode}`, `график откликов: ${formatSchedule(sched)}`, balanceLine, `seen за 24ч:`, ...lines].join("\n"),
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
      // Меню команд перерегистрируем на каждую команду: свежее после любого
      // деплоя и перезаписывает протухшие записи (setMyCommands заменяет список).
      ctx.waitUntil(setMyCommands(env).catch((e) => console.warn("setMyCommands failed:", e)));
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
    if (String(cbChatId) === env.TELEGRAM_CHAT_ID && callback.data.startsWith("sched:")) {
      const action = callback.data.slice("sched:".length);
      log("tg.callback", { data: callback.data });
      ctx.waitUntil(
        (async () => {
          const sched = await getSchedule(env);
          const { next, error } = applyScheduleDelta(sched, action);
          if (error !== null) {
            // Граница окна или мусорный callback — состояние не трогаем,
            // только всплывающая подсказка.
            await answerCallbackQuery(env, callback.id, error);
            return;
          }
          await setSchedule(env, next);
          await answerCallbackQuery(env, callback.id, "ок");
          // Заменяем то же сообщение: новая подпись + клавиатура под новое
          // состояние (раскладка кнопок зависит от enabled).
          const cbMessageId = callback.message?.message_id;
          if (cbChatId !== undefined && typeof cbMessageId === "number") {
            await editMessage(
              env,
              cbChatId,
              cbMessageId,
              scheduleCaption(next),
              buildScheduleKeyboard(next),
            );
          } else {
            await sendTelegram(env, scheduleCaption(next), buildScheduleKeyboard(next));
          }
        })().catch((e) => console.error("tg.sched-callback failed:", e)),
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
    // Новая сессия: снимаем выключатель протухшей авторизации.
    await clearAuthInvalid(env);
    log("fl.auth.override-set", {});
    return jsonResponse({ ok: true });
  }
  return new Response("Not Found", { status: 404 });
}

// Идентификаторы каналов, для которых живёт ChannelRunner (общий feed +
// включённые поисковые каналы).
function activeChannelIds(env: Env): ChannelId[] {
  return getChannels(env)
    .filter((c) => c.enabled)
    .map((c) => c.id);
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
        // Ручное будение каналов: каждый runner получит ближайший alarm.
        const ids = activeChannelIds(env);
        await Promise.all(ids.map((id) => channelRunnerStub(env, id).ensureAlarm()));
        return jsonResponse({ ok: true, channels: ids });
      }
      if (request.method === "GET" && url.pathname === "/test/channels") {
        const ids = activeChannelIds(env);
        const statuses = await Promise.all(
          ids.map((id) => channelRunnerStub(env, id).status()),
        );
        return jsonResponse({ channels: statuses });
      }
      if (request.method === "GET" && url.pathname === "/test/profiles") {
        return jsonResponse({ profiles: await fetchProfileMap(env) });
      }
      if (request.method === "POST" && url.pathname === "/test/set-webhook") {
        return await handleSetWebhook(request, env);
      }
      if (request.method === "GET" && url.pathname === "/test/logs") {
        return jsonResponse(await readRing(env));
      }
      if (request.method === "GET" && url.pathname === "/test/bids-balance") {
        // Хранимое состояние бюджета (баланс событийный, см. BidBudget).
        return jsonResponse(await bidBudgetStub(env).debugState());
      }
      if (request.method === "POST" && url.pathname === "/test/milestones") {
        let body: { dryRun?: boolean; force?: boolean } = {};
        const raw = await request.text();
        if (raw.trim() !== "") {
          try {
            body = JSON.parse(raw) as { dryRun?: boolean; force?: boolean };
          } catch {
            return jsonResponse({ error: "invalid JSON body" }, 400);
          }
        }
        // Без тела — по умолчанию пробный прогон, без реальных запросов.
        const dryRun = body.dryRun ?? true;
        try {
          const result = await checkMilestones(env, { dryRun, force: true });
          return jsonResponse(result);
        } catch (e) {
          return jsonResponse({ error: String(e).slice(0, 300) }, 502);
        }
      }
      if (url.pathname === "/admin/fl-auth") {
        return await handleFlAuth(request, env);
      }
    } catch (e) {
      return jsonResponse({ error: String(e) }, 500);
    }

    return new Response("Not Found", { status: 404 });
  },

  // Watchdog (1/мин): будим alarm-цепочки всех активных каналов, банка seen
  // и бюджета ставок — если цепочка жива, вызовы no-op.
  scheduled(event, env, ctx): void {
    for (const id of activeChannelIds(env)) {
      const stub = channelRunnerStub(env, id);
      ctx.waitUntil(stub.ensureAlarm().catch((e) => console.error(`do wake failed: ${id}`, e)));
    }
    ctx.waitUntil(ordersBankStub(env).wake().catch((e) => console.error("bank wake failed", e)));
    ctx.waitUntil(bidBudgetStub(env).wake().catch((e) => console.error("budget wake failed", e)));
  },
} satisfies ExportedHandler<Env>;
