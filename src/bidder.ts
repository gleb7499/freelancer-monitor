import type { Env, Order, ScoreResult } from "./types";
import { getConfig } from "./config";
import { recordBidSpent } from "./bids-balance";
import { getMode } from "./mode";
import { resolveWebAuth, webAuthHeaders, type WebAuth } from "./web-auth";
import { buySealedUpgrade } from "./payments";

export interface BidResult {
  placed: boolean;
  bidId?: number;
  reason?: string;
  // Запросы этапов после ставки: requested — число созданных запросов,
  // failed — текст ошибки первого сбоя (ставку не отменяет) или null.
  milestones?: { requested: number; failed: string | null };
  // Покупка sealed после ставки: "ok" | null (не покупали) | код ошибки.
  sealPurchase?: string | null;
}

// Собрать тело ставки отдельно — приёмочные проверки используют напрямую.
export function buildBidBody(
  orderId: number,
  bidderId: number,
  bidText: string,
  score: ScoreResult,
): Record<string, unknown> {
  return {
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
  const body = buildBidBody(order.id, bidderId, bidText, score);

  const res = await fetch(
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

  if (res.ok) {
    let bidId: number | undefined;
    try {
      const data = (await res.json()) as { result?: { id?: number } };
      bidId = data.result?.id;
    } catch {
      // id не критичен
    }
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
    }
    await recordBidSpent(env, `bid:${order.id}`);
    console.log("bidder.placed", {
      id: order.id,
      bidId,
      milestones: milestones.requested,
      seal: sealPurchase,
    });
    return { placed: true, bidId, milestones, sealPurchase };
  }

  const text = (await res.text()).slice(0, 300);
  // Текст ошибки API для карточки: только безопасные ASCII-символы (заголовок
  // уходит в Telegram с HTML-разметкой, латиница без разметки).
  const apiMessage = (() => {
    try {
      const m = (JSON.parse(text) as { message?: unknown }).message;
      if (typeof m !== "string" || m.trim() === "") return null;
      const clean = m.replace(/[^a-zA-Z0-9 .,'$%()\/:_-]/g, " ").replace(/\s+/g, " ").trim();
      return clean.slice(0, 140);
    } catch {
      return null;
    }
  })();
  if (text.toLowerCase().includes("already")) {
    return { placed: false, reason: "already-bid" };
  }
  if (res.status === 401) {
    console.error("bidder.oauth-invalid", { id: order.id });
    return { placed: false, reason: "oauth-invalid" };
  }
  // Часть заказов требует минимальный баланс на счету (~$20) для ставки.
  const lower = text.toLowerCase();
  if (
    lower.includes("balance") ||
    lower.includes("deposit") ||
    lower.includes("funds") ||
    lower.includes("insufficient")
  ) {
    console.error("bidder.insufficient-balance", { id: order.id, status: res.status, text });
    return { placed: false, reason: `insufficient-balance${apiMessage ? `: ${apiMessage}` : ""}` };
  }
  // Крипто/премиум-заказы требуют верификации аккаунта (403 RESTRICTED...).
  if (
    res.status === 403 &&
    (lower.includes("verified") || lower.includes("verification") || lower.includes("restricted"))
  ) {
    console.error("bidder.verification-required", { id: order.id, text });
    return { placed: false, reason: "verification-required" };
  }
  console.error("bidder.failed", { id: order.id, status: res.status, text });
  return { placed: false, reason: `http-${res.status}${apiMessage ? `: ${apiMessage}` : ""}` };
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
