import type { Env, Order, ScoreResult } from "./types";
import { getConfig } from "./config";
import { recordBidSpent } from "./bids-balance";
import { getMode } from "./mode";
import { resolveWebAuth, webAuthHeaders, markAuthInvalid, type WebAuth } from "./web-auth";
import { buySealedUpgrade } from "./payments";
import { profileChannel } from "./channels";
import { resolveProfileId } from "./profiles";
import { sendTelegram, alert } from "./telegram";

export interface BidResult {
  placed: boolean;
  bidId?: number;
  reason?: string;
  // true — был реальный POST ставки (не пре-полётный отказ). По таким отказам
  // бюджет обновляет баланс (вдруг отказ = «bids закончились»).
  attempted?: boolean;
  // Запросы этапов после ставки: requested — число созданных запросов,
  // failed — текст ошибки первого сбоя (ставку не отменяет) или null.
  milestones?: { requested: number; failed: string | null };
  // Покупка sealed после ставки: "ok" | null (не покупали) | код ошибки.
  sealPurchase?: string | null;
  // true — ответ на POST не получен (обрыв/таймаут), ставка подтверждена сверкой.
  recovered?: boolean;
}

// Собрать тело ставки отдельно — приёмочные проверки используют напрямую.
export function buildBidBody(
  orderId: number,
  bidderId: number,
  bidText: string,
  score: ScoreResult,
  profileId: number | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    project_id: orderId,
    bidder_id: bidderId,
    description: bidText,
    amount: score.bid_amount,
    period: score.delivery_days,
    // Константа фронта при наличии этапов (не менее 2); 100 — hourly и
    // мелкий fixed с одним этапом (score.milestones === null).
    milestone_percentage:
      score.milestones !== null && score.milestones.length >= 2 ? 50 : 100,
    showcases: [],
  };
  // Фронт шлёт profile_id всегда, когда профилей больше одного.
  if (profileId !== null) body.profile_id = profileId;
  return body;
}

// Одноразовый алерт в Telegram (флаг в KV на 1 ч): профиль канала не
// разрешился в числовой id.
async function alertProfileUnresolved(env: Env, profileName: string, isDefault: boolean): Promise<void> {
  const key = "tg:alert:profile-unresolved";
  const existing = await env.ORDERS_KV.get(key);
  if (existing) return;
  const text = isDefault
    ? `⚠️ Профиль «${profileName}» не разрешился через API — ставка пойдёт без profile_id (подсказка реестра тоже пуста)`
    : `⛔ Профиль «${profileName}» не разрешился через API и в реестре нет подсказки — ставка отменена`;
  try {
    await sendTelegram(env, text);
    await env.ORDERS_KV.put(key, "1", { expirationTtl: 3600 });
  } catch (err) {
    console.warn("alert profile-unresolved failed:", err);
  }
}

// Разместить ставку. Основной путь — веб-авторизация freelancer-auth-v2
// (доказана живой ставкой; официальный API с Bearer-ключом ставку ни разу
// не поставил). Фолбэк при отсутствии веб-сессии — старые OAuth/Bearer.
// Валюта amount: score.bid_amount уже в родной валюте заказа — отправляем
// как есть; суммы этапов из score.milestones согласованы с ней скорингом.

export async function placeBid(
  env: Env,
  order: Order,
  score: ScoreResult,
  bidText: string | null,
): Promise<BidResult> {
  const mode = await getMode(env);
  if (mode === "off") {
    console.log("bidder.skipped: mode=off", { id: order.id });
    return { placed: false, reason: "mode-off" };
  }
  if (mode === "test") {
    console.log("bidder.test-mode", {
      id: order.id,
      amount: score.bid_amount,
      days: score.delivery_days,
      hasText: bidText !== null,
    });
    return { placed: false, reason: "test-mode" };
  }

  if (!(score.bid_amount > 0)) {
    console.error("bidder.invalid-amount", { id: order.id, amount: score.bid_amount });
    return { placed: false, reason: "invalid-amount" };
  }

  const cfg = getConfig(env);
  const webAuth = await resolveWebAuth(env);
  // Фолбэк — только когда веб-сессии нет вообще.
  const fallbackHeaders: Record<string, string> | null = webAuth
    ? null
    : cfg.flOauthToken
      ? { "Freelancer-OAuth-V1": cfg.flOauthToken }
      : cfg.flApiKey
        ? { Authorization: `Bearer ${cfg.flApiKey}` }
        : null;
  if (!webAuth && !fallbackHeaders) {
    console.error("bidder.oauth-missing", { id: order.id });
    return { placed: false, reason: "oauth-missing" };
  }
  if (!webAuth && !cfg.flUserId) {
    console.error("bidder.fl-user-id-missing", { id: order.id });
    return { placed: false, reason: "fl-user-id-missing" };
  }
  if (!bidText || bidText.trim() === "") {
    return { placed: false, reason: "empty-bid-text" };
  }
  // Сервер отвечает 500 на описание короче 100 символов — не тратим запрос.
  if (bidText.trim().length < 100) {
    return { placed: false, reason: "bid-text-too-short" };
  }
  // Проекты с бейджем RECRUITER — только для Preferred Freelancer; наш аккаунт
  // им не является, API отклонил бы ставку (403). Не тратим запрос.
  if (order.upgrades.recruiter) {
    return { placed: false, reason: "preferred-only" };
  }

  // Конкуренцию оценивает скоринг (фактор, не вето; см. prompts/scoring-system.md).
  // Ранее здесь был preflight на bid_count — снят (подробности в истории git).

  const authHeaders = webAuth
    ? webAuthHeaders(webAuth)
    : (fallbackHeaders as Record<string, string>);
  const bidderId = Number(webAuth?.userId ?? cfg.flUserId);
  // Профиль канала отклика → числовой id профиля Freelancer (null — без поля).
  const channel = profileChannel(score.profile);
  const profileId = await resolveProfileId(env, channel.profileName);
  if (profileId === null && channel.profileName !== null) {
    await alertProfileUnresolved(env, channel.profileName, channel.isDefault);
    if (channel.isDefault === false) {
      console.error("bidder.profile-unresolved", { id: order.id, profile: channel.profileName });
      return { placed: false, reason: "profile-unresolved" };
    }
  }
  const body = buildBidBody(order.id, bidderId, bidText, score, profileId);

  let res: Response | null = null;
  let networkError: string | null = null;
  try {
    res = await fetch(
      `${cfg.freelancerBase}/bids/?compact=true&new_errors=true&new_pools=true`,
      {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch (e) {
    networkError = String(e).slice(0, 120);
  }

  // Обрыв/таймаут: запрос мог дойти до сервера. Сверяемся со списком своих
  // ставок по заказу, чтобы не потерять размещённую ставку (этапы, sealed,
  // ledger, карточка) и не принять неразмещённую за размещённую.
  let recovered = false;
  let bidId: number | undefined;
  let placedOk = false;
  if (res === null) {
    console.error("bidder.network-error", { id: order.id, err: networkError });
    const found = await findOwnBid(cfg.freelancerBase, authHeaders, order.id, bidderId);
    if (found === "error") {
      await alert(
        env,
        `Исход ставки по заказу ${order.id} неизвестен: обрыв связи, сверка не удалась. Проверь вручную на сайте`,
        { key: "bid-unknown-outcome", ttlSec: 300 },
      );
      return { placed: false, reason: "unknown-outcome", attempted: true };
    }
    if (found === null) {
      return { placed: false, reason: `network-error: ${networkError}`, attempted: true };
    }
    placedOk = true;
    recovered = true;
    bidId = found;
  } else if (res.ok) {
    placedOk = true;
    try {
      const data = (await res.json()) as { result?: { id?: number } };
      bidId = data.result?.id;
    } catch {
      // id восстановим сверкой
    }
    if (bidId === undefined) {
      const found = await findOwnBid(cfg.freelancerBase, authHeaders, order.id, bidderId);
      if (typeof found === "number") bidId = found;
    }
  }

  if (placedOk) {
    // Запросы этапов и покупка sealed — после успешной ставки.
    let milestones: { requested: number; failed: string | null } = {
      requested: 0,
      failed: null,
    };
    let sealPurchase: string | null = null;
    if (bidId !== undefined) {
      if (score.milestones !== null) {
        milestones = await requestMilestones(
          env,
          cfg.freelancerBase,
          authHeaders,
          order.id,
          bidId,
          score,
        );
      }
      // Sealed покупается только с веб-авторизацией (корзина платежей).
      sealPurchase = webAuth
        ? await buySealedUpgrade(webAuth, bidId, order.id)
        : "no-web-auth";
      if (sealPurchase !== "ok") {
        console.warn("bidder.seal-failed", { id: order.id, bidId, reason: sealPurchase });
      }
    } else {
      console.warn("bidder.bid-id-missing", { id: order.id });
    }
    await recordBidSpent(env, `bid:${order.id}`);
    console.log("bidder.placed", {
      id: order.id,
      bidId,
      milestones: milestones.requested,
      seal: sealPurchase,
      recovered,
    });
    return { placed: true, bidId, milestones, sealPurchase, recovered };
  }

  // Здесь res не null и !res.ok.
  const failedRes = res as Response;
  const text = (await failedRes.text()).slice(0, 300);
  // Текст ошибки API для карточки: только безопасные ASCII-символы (заголовок
  // уходит в Telegram с HTML-разметкой, латиница без разметки).
  const apiFields = parseApiError(text);
  const apiMessage = (() => {
    const m = apiFields.message;
    if (m === null) return null;
    const clean = m.replace(/[^a-zA-Z0-9 .,'$%()\/:_-]/g, " ").replace(/\s+/g, " ").trim();
    return clean === "" ? null : clean.slice(0, 140);
  })();
  // Классификация — по полям ошибки (error_code, message), а не по сырому
  // телу целиком; если тело не JSON — по тексту.
  const haystack = apiFields.haystack !== "" ? apiFields.haystack : text.toLowerCase();
  if (haystack.includes("already")) {
    return { placed: false, reason: "already-bid", attempted: true };
  }
  if (failedRes.status === 401) {
    console.error("bidder.oauth-invalid", { id: order.id });
    // Веб-сессия отклонена: останавливаем поисковые каналы до замены сессии.
    if (webAuth) await markAuthInvalid(env, "bid");
    return { placed: false, reason: "oauth-invalid", attempted: true };
  }
  // Часть заказов требует минимальный баланс на счету (~$20) для ставки.
  const lower = haystack;
  if (
    lower.includes("balance") ||
    lower.includes("deposit") ||
    lower.includes("funds") ||
    lower.includes("insufficient")
  ) {
    console.error("bidder.insufficient-balance", { id: order.id, status: failedRes.status, text });
    return { placed: false, reason: `insufficient-balance${apiMessage ? `: ${apiMessage}` : ""}`, attempted: true };
  }
  // Крипто/премиум-заказы требуют верификации аккаунта (403 RESTRICTED...).
  if (
    failedRes.status === 403 &&
    (lower.includes("verified") || lower.includes("verification") || lower.includes("restricted"))
  ) {
    console.error("bidder.verification-required", { id: order.id, text });
    return { placed: false, reason: "verification-required", attempted: true };
  }
  console.error("bidder.failed", { id: order.id, status: failedRes.status, text });
  return { placed: false, reason: `http-${failedRes.status}${apiMessage ? `: ${apiMessage}` : ""}`, attempted: true };
}

// Поля ошибки API: message и error_code (плюс вложенный error.*), собранные в
// строку для классификации. Не JSON — пустые значения.
export function parseApiError(text: string): { message: string | null; haystack: string } {
  try {
    const data = JSON.parse(text) as {
      message?: unknown;
      error_code?: unknown;
      error?: { message?: unknown; code?: unknown } | unknown;
    };
    const nested = typeof data.error === "object" && data.error !== null
      ? (data.error as { message?: unknown; code?: unknown })
      : {};
    const parts = [data.message, data.error_code, nested.message, nested.code].filter(
      (x): x is string => typeof x === "string" && x.trim() !== "",
    );
    const message =
      typeof data.message === "string" && data.message.trim() !== ""
        ? data.message
        : typeof nested.message === "string" && nested.message.trim() !== ""
          ? nested.message
          : null;
    return { message, haystack: parts.join(" ").toLowerCase() };
  } catch {
    return { message: null, haystack: "" };
  }
}

// Сверка после обрыва: есть ли у нас живая ставка на этот заказ.
// number — id найденной ставки, null — ставки нет, "error" — сверка не удалась.
export async function findOwnBid(
  freelancerBase: string,
  authHeaders: Record<string, string>,
  projectId: number,
  bidderId: number,
): Promise<number | null | "error"> {
  try {
    const res = await fetch(
      `${freelancerBase}/bids/?projects[]=${projectId}&bidders[]=${bidderId}`,
      { headers: authHeaders, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return "error";
    const data = (await res.json()) as { status?: string; result?: { bids?: unknown } };
    if (data.status !== "success") return "error";
    const raw = data.result?.bids;
    const list: { id?: unknown; project_id?: unknown; bidder_id?: unknown; retracted?: unknown }[] =
      Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
    for (const b of list) {
      if (!b || b.retracted === true) continue;
      if (b.project_id !== undefined && Number(b.project_id) !== projectId) continue;
      if (b.bidder_id !== undefined && Number(b.bidder_id) !== bidderId) continue;
      const id = Number(b.id);
      if (Number.isFinite(id) && id > 0) return id;
    }
    return null;
  } catch {
    return "error";
  }
}

// Запросы этапов: отдельная сущность, не часть тела ставки. На каждый элемент
// score.milestones — один POST. Сумма этапа ≡ сумме ставки (гарантирует скоринг).
// Созданные запросы сохраняются в KV ms:req:<bidId> (TTL 60 дней) для
// milestones.ts. Ошибка одного запроса не отменяет остальные и ставку.
async function requestMilestones(
  env: Env,
  freelancerBase: string,
  authHeaders: Record<string, string>,
  projectId: number,
  bidId: number,
  score: ScoreResult,
): Promise<{ requested: number; failed: string | null }> {
  const requests: { id: number; amount: number; description: string }[] = [];
  let failed: string | null = null;
  for (const m of score.milestones ?? []) {
    try {
      const res = await fetch(
        `${freelancerBase}/milestone_requests/?webapp=1&compact=true&new_errors=true&new_pools=true`,
        {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ project_id: projectId, bid_id: bidId, description: m.description, amount: m.amount }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!res.ok) {
        if (failed === null) failed = `http-${res.status}`;
        continue;
      }
      const id = ((await res.json()) as { result?: { id?: number } }).result?.id;
      requests.push({ id: id ?? 0, amount: m.amount, description: m.description });
    } catch (e) {
      if (failed === null) failed = String(e).slice(0, 100);
    }
  }
  try {
    await env.ORDERS_KV.put(
      `ms:req:${bidId}`,
      JSON.stringify({ project_id: projectId, requests, ts: Date.now() }),
      { expirationTtl: 60 * 86400 },
    );
  } catch {
    // запросы не сохранились — не критично
  }
  return { requested: requests.length, failed };
}
