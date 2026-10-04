import type { Env, Order, ScoreResult } from "./types";
import { getConfig } from "./config";
import { fetchProjectsByIds } from "./enrich";
import { recordBidSpent } from "./bids-balance";
import { getMode } from "./mode";

export interface BidResult {
  placed: boolean;
  bidId?: number;
  reason?: string;
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

  // Этапная оплата по политике: fixed >= ~$150 на руки ИЛИ клиент без
  // верификации — стартовый этап 30%, иначе одним этапом в конце.
  const rate =
    order.budget_min > 0 && order.budget_min_original > 0
      ? order.budget_min_original / order.budget_min
      : 1;
  const netUsd = score.net_amount / rate;
  const milestonePercentage =
    order.type === "fixed" &&
    (netUsd >= 150 || order.client?.payment_verified === false)
      ? 30
      : 100;

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
    await recordBidSpent(env, `bid:${order.id}`);
    console.log("bidder.placed", { id: order.id, bidId });
    return { placed: true, bidId };
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
    return { placed: false, reason: "insufficient-balance" };
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
