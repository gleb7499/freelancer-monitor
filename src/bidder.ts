import type { Env, Order, ScoreResult } from "./types";
import { getConfig, type Config } from "./config";
import { fetchProjectsByIds } from "./enrich";
import { recordBidSpent } from "./bids-balance";
import { getMode } from "./mode";

export interface BidResult {
  placed: boolean;
  bidId?: number;
  reason?: string;
  // Покупка sealed после ставки: "ok" | null (не покупали) | код ошибки.
  sealPurchase?: string | null;
}

// Разместить ставку через официальный API.
// Валюта amount: API ждёт сумму в валюте проекта. score.bid_amount уже хранится
// в родной валюте заказа (LLM предлагает сумму в currency_code, код нормализует) —
// пересчёт не нужен, отправляем как есть.

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

  // live-режим без токенов — алертим через reason, не падаем.
  // Основной путь — OAuth-токен аккаунта; фолбэк — ключ Develop API
  // (Authorization: Bearer, проверено 04.10.2026).
  const cfg = getConfig(env);
  const authHeaders: Record<string, string> | null = cfg.flOauthToken
    ? { "Freelancer-OAuth-V1": cfg.flOauthToken }
    : cfg.flApiKey
      ? { Authorization: `Bearer ${cfg.flApiKey}` }
      : null;
  if (!authHeaders) {
    console.error("bidder.oauth-missing", { id: order.id });
    return { placed: false, reason: "oauth-missing" };
  }
  if (!cfg.flUserId) {
    console.error("bidder.fl-user-id-missing", { id: order.id });
    return { placed: false, reason: "fl-user-id-missing" };
  }
  if (!bidText || bidText.trim() === "") {
    return { placed: false, reason: "empty-bid-text" };
  }
  // Проекты с бейджем RECRUITER — только для Preferred Freelancer; наш аккаунт
  // им не является, API отклонил бы ставку (403). Не тратим запрос.
  if (order.upgrades.recruiter) {
    return { placed: false, reason: "preferred-only" };
  }

  // Pre-flight: свежий bid_count. Заказ с разогнавшейся конкуренцией — пропуск.
  try {
    const fresh = await fetchProjectsByIds(env, [order.id]);
    const freshOrder = fresh[0];
    if (freshOrder && freshOrder.bids > 10) {
      console.log("bidder.preflight-cancel", { id: order.id, bids: freshOrder.bids });
      return { placed: false, reason: "bids>10@preflight" };
    }
  } catch (e) {
    // Pre-flight недоступен (сеть/API) — не рискуем ставкой вслепую.
    console.error("bidder.preflight-failed", { id: order.id, err: String(e) });
    return { placed: false, reason: "preflight-failed" };
  }

  // Этапная оплата: ВСЕГДА на fixed, стартовый этап 30% (полный план —
  // score.milestone_plan, 30/70, 30/30/40 или 30/30/30/10; rest через
  // milestone_requests после назначения). Hourly — без этапов.
  const milestonePercentage = order.type === "fixed" ? 30 : 100;

  const body = {
    project_id: order.id,
    bidder_id: Number(cfg.flUserId),
    description: bidText,
    amount: score.bid_amount,
    period: score.delivery_days,
    milestone_percentage: milestonePercentage,
  };

  const res = await fetch(`${cfg.freelancerBase}/bids/`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (res.ok) {
    let bidId: number | undefined;
    try {
      const data = (await res.json()) as { result?: { id?: number } };
      bidId = data.result?.id;
    } catch {
      // id не критичен
    }
    // План этапов и покупка апгрейдов — после успешной ставки.
    let sealPurchase: string | null = null;
    if (bidId !== undefined) {
      try {
        await env.ORDERS_KV.put(
          `ms:plan:${bidId}`,
          JSON.stringify({ plan: score.milestone_plan ?? [30, 70], ts: Date.now() }),
          { expirationTtl: 60 * 86400 },
        );
      } catch {
        // план не сохранился — milestones.ts fallback на [30, 70]
      }
      if (score.take_upgrades.includes("sealed") && !order.hidebids) {
        sealPurchase = await buyBidUpgrade(cfg, bidId, "seal");
        if (sealPurchase !== "ok") {
          console.warn("bidder.seal-failed", { id: order.id, bidId, reason: sealPurchase });
        } else {
          sealPurchase = "ok";
        }
      }
    }
    await recordBidSpent(env, `bid:${order.id}`);
    console.log("bidder.placed", { id: order.id, bidId });
    return { placed: true, bidId, sealPurchase };
  }

  const text = (await res.text()).slice(0, 300);
  // Текст ошибки API для карточки: только безопасные ASCII-символы (заголовок
  // уходит в Telegram с HTML-parse, латиница без разметки).
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

// Покупка апгрейда существующей ставки: PUT /bids/{id}/ action=seal|sponsor.
// Проверено 05.10.2026: sealed через API требует Preferred Freelancer Program
// (USER_NOT_IN_PFP), хотя веб-форма предлагает его за $0.10 — покупка может
// не пройти; sponsored требует amount, семантика суммы не до конца ясна
// (см. AGENT.md), поэтому автоматом покупаем только sealed.
export async function buyBidUpgrade(
  cfg: Config,
  bidId: number,
  action: "seal" | "sponsor",
): Promise<"ok" | string> {
  try {
    const res = await fetch(`${cfg.freelancerBase.replace(/\/+$/, "")}/bids/${bidId}/`, {
      method: "PUT",
      headers: {
        ...(cfg.flOauthToken
          ? { "Freelancer-OAuth-V1": cfg.flOauthToken }
          : { Authorization: `Bearer ${cfg.flApiKey}` }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return "ok";
    const text = (await res.text()).slice(0, 200);
    try {
      return (JSON.parse(text) as { error_code?: string }).error_code ?? `http-${res.status}`;
    } catch {
      return `http-${res.status}`;
    }
  } catch (e) {
    return String(e).slice(0, 100);
  }
}
