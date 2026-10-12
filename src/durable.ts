import type { Env, Order, ScoreResult } from "./types";
import { DurableObject } from "cloudflare:workers";
import { getConfig, type Config } from "./config";
import { channelById, type ChannelId } from "./channels";
import { fetchActiveOrders, type ChannelState } from "./sources/freelancer-active";
import { fetchSearchOrders } from "./sources/freelancer-search";
import { getMode, type Mode } from "./mode";
import { getSchedule, isWithinSchedule } from "./schedule";
import { getBidsBalance } from "./bids-balance";
import { checkMilestones } from "./milestones";
import { preBidRejectReason } from "./service";
import { fetchProjectClient, fetchPortfolio, fetchOrderArtifacts } from "./enrich";
import { scoreOrder, buildBidMessages, generateBidText, KimiError } from "./kimi";
import { placeBid } from "./bidder";
import { enforceUpgradeCap, priceUpgrades, sponsoredDailyLeft } from "./upgrades";
import {
  formatOrderCard,
  formatPassCard,
  formatRejectCard,
  sendTelegram,
  alert,
  type ManualActions,
} from "./telegram";
import { log, logImportant, logError, heartbeat, flushLogBuffer } from "./logger";
import { runWithConcurrency, bySubmitTsDesc } from "./util";

// ---------------------------------------------------------------------------
// Общие константы и помощники (перенос из бывшего index.ts без изменений логики)
// ---------------------------------------------------------------------------

const TICK_INTERVAL_MS = 10_000;
// Пул одновременных LLM-вызовов на канал: при всплеске заказов батч
// обрабатывается параллельно, но не выше этого потолка (Kimi 429).
const LLM_CONCURRENCY = 3;

const BIDS_UNSET_ALERT_KEY = "bids:unset-alerted";

// Локальная копия механизма «алерт не чаще раза в TTL» (была в index.ts).
async function sendAuthAlertOnce(env: Env, key: string, ttlSec: number, message: string): Promise<void> {
  const already = await env.ORDERS_KV.get(key);
  if (already !== null) return;
  await env.ORDERS_KV.put(key, String(Date.now()), { expirationTtl: ttlSec });
  await alert(env, message);
}

// Потолок weekly limit для hourly: LLM может только снизить лимит.
export function clampWeeklyLimit(score: ScoreResult, cfg: Config): void {
  if (score.weekly_limit_hours === null) return;
  const cap = Math.min(cfg.weeklyLimitHours, 40);
  score.weekly_limit_hours = Math.min(score.weekly_limit_hours, cap);
}

// Свежие ставки заказа: GET /bids/?projects[]={id} с той же логикой авторизации,
// что в placeBid (OAuth либо Bearer). Слот sponsored свободен, если ни у одной
// ставки нет sponsored=true. bids приходит списком или словарём (оба разбираем,
// по образцу milestones.ts fetchMyBids). Ошибка/не-ok → null ("не проверен").
async function fetchSponsoredSlotFree(
  env: Env,
  cfg: Config,
  order: Order,
): Promise<boolean | null> {
  const authHeaders: Record<string, string> | null = cfg.flOauthToken
    ? { "Freelancer-OAuth-V1": cfg.flOauthToken }
    : cfg.flApiKey
      ? { Authorization: `Bearer ${cfg.flApiKey}` }
      : null;
  if (!authHeaders) return null;
  try {
    const res = await fetch(`${cfg.freelancerBase}/bids/?projects[]=${order.id}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { status?: string; result?: { bids?: unknown } };
    if (data.status !== "success") return null;
    const bids = data.result?.bids;
    const list: { sponsored?: boolean }[] = Array.isArray(bids)
      ? (bids as { sponsored?: boolean }[])
      : bids && typeof bids === "object"
        ? (Object.values(bids) as { sponsored?: boolean }[])
        : [];
    return !list.some((b) => b && b.sponsored === true);
  } catch (e) {
    console.warn("fetchSponsoredSlotFree failed:", { id: order.id, err: String(e) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// RPC-заглушки Durable Objects (wrangler types даёт plain DurableObjectNamespace,
// поэтому методы вызываем через узкий каст типа).
// ---------------------------------------------------------------------------

interface OrdersBankStub {
  checkAndMark(orderId: number, source: string, ts: number): Promise<"new" | "duplicate">;
  updateStatus(orderId: number, status: string, reason: string | null): Promise<void>;
  wake(): Promise<void>;
}

interface BidBudgetStub {
  reserve(): Promise<{ granted: boolean; reservation?: string }>;
  release(reservation: string): Promise<void>;
  spend(reservation: string): Promise<void>;
  wake(): Promise<void>;
}

interface ChannelRunnerStub {
  ensureAlarm(): Promise<void>;
  status(): Promise<ChannelStatus>;
}

export interface ChannelStatus {
  id: string;
  lastFetchAt: number | null;
  lastOrdersCount: number | null;
  lastError: string | null;
  inFlight: number;
  alarm: number | null;
}

export function ordersBankStub(env: Env): OrdersBankStub {
  return env.ORDERS_BANK.get(env.ORDERS_BANK.idFromName("bank")) as unknown as OrdersBankStub;
}

export function bidBudgetStub(env: Env): BidBudgetStub {
  return env.BIDS_BUDGET.get(env.BIDS_BUDGET.idFromName("budget")) as unknown as BidBudgetStub;
}

export function channelRunnerStub(env: Env, id: ChannelId): ChannelRunnerStub {
  return env.CHANNEL_RUNNER.get(env.CHANNEL_RUNNER.idFromName(id)) as unknown as ChannelRunnerStub;
}

// ---------------------------------------------------------------------------
// ChannelRunner: один инстанс на канал (имя = ChannelId), alarm-цепочка тиков.
// ---------------------------------------------------------------------------

export class ChannelRunner extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private get channelId(): ChannelId {
    return this.ctx.id.name as ChannelId;
  }

  // Сторож (cron 1/мин): будим цепочку, если она прервалась (деплой, ошибка).
  async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing < Date.now() - 60_000) {
      await this.ctx.storage.setAlarm(Date.now() + 100);
    }
  }

  // Статус канала для /test/channels.
  async status(): Promise<ChannelStatus> {
    const s = this.ctx.storage;
    return {
      id: this.channelId,
      lastFetchAt: (await s.get<number>("lastFetchAt")) ?? null,
      lastOrdersCount: (await s.get<number>("lastOrdersCount")) ?? null,
      lastError: (await s.get<string>("lastError")) ?? null,
      inFlight: (await s.get<number>("inFlight")) ?? 0,
      alarm: await s.getAlarm(),
    };
  }

  async alarm(): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.tick(this.channelId);
      log("channel.tick-done", { channel: this.channelId, durationMs: Date.now() - startedAt });
      await heartbeat(this.env, { channel: this.channelId, durationMs: Date.now() - startedAt });
    } catch (e) {
      console.error(`channel ${this.channelId} tick failed`, e);
      await this.ctx.storage.put("lastError", String(e).slice(0, 300));
      await logError(this.env, "channel.error", {
        channel: this.channelId,
        message: String(e).slice(0, 300),
      });
    } finally {
      // Цепочка не должна прерваться даже при исключении.
      await this.ctx.storage.put("alarm", Date.now());
      await this.ctx.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
    }
  }

  private async tick(id: ChannelId): Promise<void> {
    const env = this.env;

    // Режим off — ничего не делаем вообще.
    const mode = await getMode(env);
    if (mode === "off") {
      log("channel.off", { channel: id });
      await flushLogBuffer(env);
      return;
    }

    // Детект назначения ставок и опрос статусов этапных запросов — независимо
    // от свежих заказов и bids-баланса. Один раз на цепочку тиков: проверяет
    // только feed-канал. Ошибка не должна ломать тик.
    if (id === "feed") {
      try {
        const ms = await checkMilestones(env);
        if (ms.awarded.length > 0 || ms.requested.some((r) => !r.error)) {
          log("milestones.checked", {
            awarded: ms.awarded.length,
            requested: ms.requested.filter((r) => !r.error).length,
            skipped: ms.skipped.map((s) => s.reason),
          });
        }
      } catch (e) {
        console.error("milestones failed:", e);
        await logError(env, "milestones.error", { message: String(e).slice(0, 300) });
      }
    }

    // График работы откликов: вне окна (по Минску) опрос заказов и LLM
    // пропускаем. Этапы выше уже проверены — они идут всегда, в любое время.
    const sched = await getSchedule(env);
    if (!isWithinSchedule(sched, Date.now())) {
      log("channel.skipped-schedule", { channel: id });
      await flushLogBuffer(env);
      return;
    }

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
      log("channel.idle-no-bids", { channel: id });
      if (mode === "test") {
        await alert(env, "bids = 0 — idle: опрос и LLM остановлены до восстановления bid");
      }
      await flushLogBuffer(env);
      return;
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

    // Fetch выдачи канала. Состояние (курсор/throttle) — в хранилище самого
    // DO: «кеширование в рамках потока».
    const state: ChannelState = {
      get: async (key) => {
        const v = await this.ctx.storage.get(key);
        const s = v === undefined || v === null ? null : String(v);
        // Диагностика курсоров (времянка): почему feed перечитывает выдачу.
        if (key.includes("last_submit")) console.log(`[state] get ${key} -> ${s}`);
        return s;
      },
      put: async (key, value, ttlSec) => {
        if (key.includes("last_submit")) console.log(`[state] put ${key} = ${value}`);
        // expirationTtl поддерживается рантаймом DO, но не типами
        // @cloudflare/workers-types этой версии — каст.
        await this.ctx.storage.put(
          key,
          value,
          (ttlSec !== undefined ? { expirationTtl: ttlSec } : undefined) as never,
        );
      },
    };

    const result =
      id === "feed"
        ? await fetchActiveOrders(env, state)
        : await fetchSearchOrders(env, channelById(id), state);

    if (result.error !== null) {
      await logError(env, "active.error", { channel: id, message: result.error });
      await this.ctx.storage.put("lastError", result.error);
      if (id === "feed" && result.error.includes("UNAUTHORIZED")) {
        await sendAuthAlertOnce(
          env,
          "feed:unauth-alerted",
          3600,
          "Веб-авторизация Freelancer протухла (401) — обнови через /admin/fl-auth",
        );
      }
      await flushLogBuffer(env);
      return;
    }

    if (result.skipped) {
      await flushLogBuffer(env);
      return;
    }

    await this.ctx.storage.put("lastError", null);
    await this.ctx.storage.put("lastFetchAt", Date.now());
    await this.ctx.storage.put("lastOrdersCount", result.orders.length);
    log("channel.fetched", { channel: id, count: result.orders.length });

    // Каждый заказ выдачи — свой подпоток через общий семафор (LLM_CONCURRENCY).
    // Сортировка — bySubmitTsDesc: при дефиците bids свежие релевантнее.
    const orders = [...result.orders].sort(bySubmitTsDesc);
    const fns = orders.map((order) => async () => {
      const s = this.ctx.storage;
      const before = (await s.get<number>("inFlight")) ?? 0;
      await s.put("inFlight", before + 1);
      try {
        await runOrderPipeline(env, order);
      } catch (e) {
        // 429 и прочие — падает только этот заказ, остальные в пуле продолжают.
        console.error(`order ${order.id} processing failed:`, e);
        await logError(env, "order.error", {
          id: order.id,
          err: e instanceof KimiError && e.status === 429 ? "kimi-429" : String(e).slice(0, 200),
        });
      } finally {
        const cur = (await s.get<number>("inFlight")) ?? 1;
        await s.put("inFlight", Math.max(0, cur - 1));
      }
    });
    await runWithConcurrency(fns, LLM_CONCURRENCY);
    await flushLogBuffer(env);
  }
}

// ---------------------------------------------------------------------------
// OrdersBank: единственный владелец таблицы seen (D1). Однопоточность DO =
// арбитр отсутствия гонок между каналами на одном заказе.
// ---------------------------------------------------------------------------

const SEEN_RETENTION_MS = 30 * 86400 * 1000;

export class OrdersBank extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // Сторож: запускает суточную чистку, если alarm-цепочка не жива.
  async wake(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  // INSERT OR IGNORE атомарен даже вне однопоточности DO; changes > 0 — заказ
  // новый. Повторный вызов для того же id → "duplicate".
  async checkAndMark(orderId: number, source: string, ts: number): Promise<"new" | "duplicate"> {
    const res = await this.env.DB.prepare(
      "INSERT OR IGNORE INTO seen (id, source, status, reason, ts) VALUES (?, ?, 'new', NULL, ?)",
    )
      .bind(orderId, source, ts)
      .run();
    return (res.meta.changes ?? 0) > 0 ? "new" : "duplicate";
  }

  // Аналитика прохождения заказа по стадиям (статусы как у markAlertSeen:
  // new → passed/rejected → bid/err).
  async updateStatus(orderId: number, status: string, reason: string | null): Promise<void> {
    await this.env.DB.prepare("UPDATE seen SET status = ?, reason = ? WHERE id = ?")
      .bind(status, reason, orderId)
      .run();
  }

  async alarm(): Promise<void> {
    try {
      const cutoff = Date.now() - SEEN_RETENTION_MS;
      const res = await this.env.DB.prepare("DELETE FROM seen WHERE ts < ?").bind(cutoff).run();
      console.log("seen.cleanup", { deleted: res.meta.changes });
    } catch (e) {
      console.error("seen.cleanup failed:", e);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 86400_000);
    }
  }
}

// ---------------------------------------------------------------------------
// BidBudget: не дать потратить последний bid дважды. Резервирование до
// фактического размещения; запись в bid_ledger — только в bidder.ts.
// ---------------------------------------------------------------------------

const RESERVATION_TTL_MS = 30 * 60_000;
const BALANCE_CACHE_MS = 60_000;

interface BudgetData {
  inFlight: number;
  reservations: Record<string, number>;
  balanceCache: { value: number | null; ts: number };
}

const EMPTY_BUDGET: BudgetData = {
  inFlight: 0,
  reservations: {},
  balanceCache: { value: null, ts: 0 },
};

export class BidBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // Сторож: запускает чистку протухших резервов, если цепочка не жива.
  async wake(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RESERVATION_TTL_MS);
    }
  }

  private async read(): Promise<BudgetData> {
    const raw = await this.ctx.storage.get<BudgetData>("data");
    if (raw === undefined || raw === null) return { ...EMPTY_BUDGET, reservations: {} };
    return {
      inFlight: raw.inFlight ?? 0,
      reservations: raw.reservations ?? {},
      balanceCache: raw.balanceCache ?? { value: null, ts: 0 },
    };
  }

  private async write(data: BudgetData): Promise<void> {
    await this.ctx.storage.put("data", data);
  }

  private async balance(data: BudgetData): Promise<number | null> {
    if (Date.now() - data.balanceCache.ts < BALANCE_CACHE_MS) {
      return data.balanceCache.value;
    }
    let value: number | null = null;
    try {
      value = (await getBidsBalance(this.env)).balance;
    } catch (e) {
      console.warn("BidBudget getBidsBalance failed:", String(e));
    }
    data.balanceCache = { value, ts: Date.now() };
    return value;
  }

  // Зарезервировать bid под предстоящую ставку. Отказ, если известный баланс
  // минус уже зарезервированные <= 0. null-баланс (не читается) — не блокируем.
  async reserve(): Promise<{ granted: boolean; reservation?: string }> {
    const data = await this.read();
    const balance = await this.balance(data);
    if (balance !== null && balance - data.inFlight <= 0) {
      await this.write(data);
      return { granted: false };
    }
    data.inFlight += 1;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    data.reservations[id] = Date.now() + RESERVATION_TTL_MS;
    await this.write(data);
    return { granted: true, reservation: id };
  }

  async release(reservation: string): Promise<void> {
    const data = await this.read();
    if (data.reservations[reservation] === undefined) return;
    delete data.reservations[reservation];
    data.inFlight = Math.max(0, data.inFlight - 1);
    await this.write(data);
  }

  // Ставка реально размещена: резерв превращается в трату (ledger пишет bidder).
  async spend(reservation: string): Promise<void> {
    const data = await this.read();
    if (data.reservations[reservation] === undefined) return;
    delete data.reservations[reservation];
    data.inFlight = Math.max(0, data.inFlight - 1);
    await this.write(data);
  }

  // Периодическая чистка: резерв, переживший TTL (воркер умер mid-pipeline),
  // освобождает слот. inFlight восстанавливаем по фактическому списку.
  async alarm(): Promise<void> {
    try {
      const data = await this.read();
      const now = Date.now();
      let expired = 0;
      for (const [id, expiresAt] of Object.entries(data.reservations)) {
        if (expiresAt <= now) {
          delete data.reservations[id];
          expired += 1;
        }
      }
      if (expired > 0) {
        console.warn("budget.expired-reservations", { expired });
      }
      data.inFlight = Object.keys(data.reservations).length;
      await this.write(data);
    } catch (e) {
      console.error("budget.alarm failed:", e);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + RESERVATION_TTL_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// runOrderPipeline: полный цикл обработки одного заказа (перенос processOrder
// из бывшего index.ts). Ошибки изолируются здесь же: лог + return.
// ---------------------------------------------------------------------------

export async function runOrderPipeline(env: Env, order: Order): Promise<void> {
  const cfg = getConfig(env);
  const mode: Mode = await getMode(env);
  const bank = ordersBankStub(env);
  const budget = bidBudgetStub(env);
  const source = order.source ?? "active";

  // 1. Арбитр свежести: банк — единственный владелец seen.
  const freshness = await bank.checkAndMark(order.id, source, Date.now());
  if (freshness === "duplicate") {
    console.log(`pipeline.duplicate ${order.id} (${source})`);
    return;
  }

  // 2/3. Enrich до гейта: мягкий пре-гейт (recruiter/KYC/крипто-скилл) решается
  // по данным заказчика из users/0.1/users — туда же уходит order.client в скоринг.
  try {
    order.client = await fetchProjectClient(env, order.owner_id ?? null);
  } catch (e) {
    order.client = null;
    console.warn("fetchProjectClient failed:", { id: order.id, err: String(e) });
  }

  // Статические гейты до LLM: физическая возможность ставки + жёсткие гейты
  // фазы 0 (конкуренция и бюджет — см. preBidRejectReason). Дубль-страховка
  // языка: источники фильтруют, но вызов pipeline возможен и извне.
  let rejectReason = preBidRejectReason(order, cfg);
  if (rejectReason === null && order.language !== "en") rejectReason = "rej:language";

  if (rejectReason !== null) {
    await bank.updateStatus(order.id, "rejected", rejectReason);
    // Test-режим: уведомляем и об отклонённых гейтом с конкретной причиной.
    if (mode === "test") {
      const human =
        rejectReason === "rej:recruiter"
          ? "recruiter-проект — только для Preferred Freelancer"
          : rejectReason === "rej:kyc-required"
            ? "заказ требует KYC-верификации аккаунта"
            : rejectReason === "rej:crypto-verified"
              ? "крипто-проект — нужна верификация Freelancer"
              : rejectReason === "rej:hot-competition"
                ? `больше ${cfg.phaseMaxBids} откликов уже при появлении — конкуренция бешеная и растёт, шанс попасть в топ выдачи низкий`
                : rejectReason === "rej:budget-fixed"
                  ? `бюджет выше потолка фазы 0 ($${cfg.phaseBudgetFixedUsd})`
                  : rejectReason === "rej:budget-hourly"
                    ? `ставка выше потолка фазы 0 ($${cfg.phaseBudgetHourlyUsd}/ч)`
                    : rejectReason;
      await sendTelegram(env, `[TEST] гейт ${rejectReason}\n\n${formatRejectCard(order, human)}`);
    }
    return;
  }
  await bank.updateStatus(order.id, "passed", null);

  // Артефакты заказа (вложения + страницы по ссылкам из описания) — только для
  // заказов, дошедших до LLM: уходят в JSON скоринга и в контекст текста ставки.
  try {
    order.artifacts = await fetchOrderArtifacts(env, order);
  } catch (e) {
    order.artifacts = null;
    console.warn("fetchOrderArtifacts failed:", { id: order.id, err: String(e) });
  }

  // 4. Скоринг.
  const score = await scoreOrder(env, order);

  if (score === null) {
    await logError(env, "order.error", { id: order.id, err: "scoring-parse-failed" });
    await bank.updateStatus(order.id, "err", "scoring-parse-failed");
    return;
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
    return;
  }

  // 5. Гейт бюджета: резерв через BidBudget — защита от перерасхода между
  // каналами и внутри батча.
  const res = await budget.reserve();
  if (!res.granted || res.reservation === undefined) {
    await sendTelegram(env, `⚠️ Отклик НЕ отправлен: bids exhausted in tick\n\n${formatOrderCard(order, score, null)}`);
    await logImportant(env, "order.notified", {
      id: order.id,
      title: order.title.slice(0, 80),
      placed: false,
      reason: "bids-exhausted-in-tick",
    });
    await bank.updateStatus(order.id, "bid", "bids-exhausted");
    return;
  }
  const reservation = res.reservation;

  try {
    // 6. Статус слота sponsored: один запрос bids на заказ — переиспользуется
    // и фильтром плана ниже, и блоком ручных действий в карточке. Ошибка /
    // не-ok → null ("не проверен"): слот как фактор не учитываем, но и не
    // блокируем из-за него отклик.
    const slotFree = await fetchSponsoredSlotFree(env, cfg, order);

    // Философия sponsored (rules): код довыкидывает sponsored из плана LLM
    // по жёстким фактам, которые модель видит хуже/позже. Неопределённость
    // слота (null) — НЕ повод выкидывать: цена допа ограничена потолком 15%.
    let sponsoredRemovedNote: string | undefined;
    if (score.take_upgrades.includes("sponsored")) {
      let reason: string | null = null;
      if (order.bids <= 15) {
        reason = "bids <= 15 (sponsored не нужен)";
      } else if (slotFree === false) {
        reason = "слот занят";
      } else {
        const left = await sponsoredDailyLeft(env);
        if (left <= 0) reason = "лимит дня: 3 sponsored/сутки";
      }
      if (reason !== null) {
        score.take_upgrades = score.take_upgrades.filter((u) => u !== "sponsored");
        sponsoredRemovedNote = reason;
      }
    }

    const cap = enforceUpgradeCap(score.take_upgrades, score.bid_amount, score.net_amount);
    if (cap.removed.length > 0) {
      score.take_upgrades = cap.kept;
    }

    let bidText: string | null = null;
    try {
      const portfolio = await fetchPortfolio(env).catch((e) => {
        console.warn("fetchPortfolio failed:", String(e));
        return null;
      });
      bidText = await generateBidText(env, order, buildBidMessages(order, score, portfolio));
    } catch (e) {
      console.error("generateBidText failed:", e);
    }

    // Текст ставки не получен (LLM недоступен/молчит) — ставку не размещаем:
    // bids не тратим, карточка предупреждает, сбой виден в кольцевом логе.
    if (bidText === null) {
      await budget.release(reservation);
      await logError(env, "order.error", { id: order.id, err: "bid-text-failed" });
      await sendTelegram(
        env,
        `⚠️ Отклик НЕ отправлен: текст ставки не получен (LLM недоступен) — заказ пропущен, bids не потрачены\n\n${formatOrderCard(order, score, null)}`,
      );
      await logImportant(env, "order.notified", {
        id: order.id,
        title: order.title.slice(0, 80),
        placed: false,
        reason: "bid-text-failed",
      });
      await bank.updateStatus(order.id, "err", "bid-text-failed");
      return;
    }

    // 7. Размещение.
    const bidResult = await placeBid(env, order, score, bidText);
    if (bidResult.placed) {
      await budget.spend(reservation);
    } else {
      await budget.release(reservation);
    }

    // Консоль действий в карточке: sealed покупает код автоматически (корзина),
    // ручных действий по нему нет; ссылка на ставку — только если она реально
    // размещена (в test-режиме bidId=null).
    const manualActions: ManualActions | null =
      score.take_upgrades.length > 0 || score.verdict === "BID"
        ? {
            bidId: bidResult.placed ? (bidResult.bidId ?? null) : null,
            slotFree,
            sponsoredPrice: priceUpgrades(["sponsored"], score.bid_amount)[0].label,
            sponsoredRemovedNote,
            test: mode === "test",
          }
        : null;

    const card = formatOrderCard(order, score, bidText, manualActions);
    const sign = order.currency_sign ?? "$";
    let header: string;
    if (mode === "test") {
      header = `[TEST] ставка НЕ отправлена`;
    } else if (bidResult.placed) {
      const upgradesPart =
        score.take_upgrades.includes("sponsored") ? "sponsored" : "без апгрейдов";
      header = `✅ Отклик отправлен: ${sign}${score.bid_amount}, план апгрейдов: ${upgradesPart}`;
      if (bidResult.sealPurchase === "no-web-auth") {
        header += `\n⚠️ sealed не куплен: нет веб-авторизации`;
      } else if (bidResult.sealPurchase !== null && bidResult.sealPurchase !== undefined && bidResult.sealPurchase !== "ok") {
        header += `\n⚠️ sealed НЕ куплен (покупка через корзину отклонена: ${bidResult.sealPurchase}) — купи вручную на сайте, если нужно`;
      }
    } else if (bidResult.reason?.startsWith("insufficient-balance")) {
      header = `⚠️ Отклик НЕ отправлен: заказ требует минимальный баланс на счету (~$20) — пополни счёт и откликни вручную`;
      if (bidResult.reason.length > "insufficient-balance".length) {
        header += `\nПричина API: ${bidResult.reason}`;
      }
      await alert(env, "Ставка отклонена: нужен минимальный баланс ~$20 на счету Freelancer");
    } else if (bidResult.reason === "verification-required") {
      header = `⚠️ Отклик НЕ отправлен: заказ закрыт для нашего аккаунта — платформа требует верификацию Freelancer (категория Cryptocurrency) либо статус Preferred Freelancer`;
    } else if (bidResult.reason === "preferred-only") {
      header = `⚠️ Отклик НЕ отправлен: заказ только для Preferred Freelancer (recruiter-проект) — наш аккаунт не подходит`;
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
    await bank.updateStatus(order.id, "bid", bidResult.placed ? null : (bidResult.reason ?? "not-placed"));
  } catch (e) {
    // Резерв отпускаем в любом случае; сбой логируем, заказ пропущен.
    await budget.release(reservation).catch(() => undefined);
    console.error(`order ${order.id} processing failed:`, e);
    await logError(env, "order.error", {
      id: order.id,
      err: e instanceof KimiError && e.status === 429 ? "kimi-429" : String(e).slice(0, 200),
    });
  }
}
