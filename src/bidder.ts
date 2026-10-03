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
// Валюта amount: API ждёт сумму в валюте проекта. score.bid_amount хранится в USD
// (парсер пересчитывал бюджет через currency.exchange_rate). Обратный пересчёт:
// для USD — как есть; для прочих валют восстанавливаем курс из бюджета заказа
// (budget_min_original / budget_min). Курса на момент ставки у нас нет — это
// осознанная погрешность, вилка бюджета её перекрывает.
function toProjectCurrency(order: Order, bidUsd: number): number {
  if (order.currency_code === "USD") return bidUsd;
  if (order.budget_min > 0 && order.budget_min_original > 0) {
    const rate = order.budget_min_original / order.budget_min;
    return Math.round(bidUsd * rate * 100) / 100;
  }
  return bidUsd;
}

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

  // live-режим без OAuth-токена — алертим через reason, не падаем.
  const cfg = getConfig(env);
  if (!cfg.flOauthToken) {
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

  const body = {
    project_id: order.id,
    bidder_id: Number(cfg.flUserId),
    description: bidText,
    amount: toProjectCurrency(order, score.bid_amount),
    period: score.delivery_days,
    milestone_percentage: 100,
  };

  const res = await fetch(`${cfg.freelancerBase}/bids/`, {
    method: "POST",
    headers: {
      "Freelancer-OAuth-V1": cfg.flOauthToken,
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
  if (text.toLowerCase().includes("already")) {
    return { placed: false, reason: "already-bid" };
  }
  if (res.status === 401) {
    console.error("bidder.oauth-invalid", { id: order.id });
    return { placed: false, reason: "oauth-invalid" };
  }
  console.error("bidder.failed", { id: order.id, status: res.status, text });
  return { placed: false, reason: `http-${res.status}` };
}
