import type { Env, Order, ScoreResult } from "./types";

export interface CtxMessage {
  role: string;
  content: string;
}

export interface OrderContext {
  order: Order;
  score: ScoreResult;
  draftMessages: CtxMessage[];
  humanizeMessages: CtxMessage[];
  bidText: string | null;
  createdTs: number;
  updatedTs: number;
}

// ТТЛ 30 суток — окно жизни сделки (ставка → обсуждение → аванс).
// Нагрузка: ~64 заказа/день × до 4 put ≈ 250 put/сутки — в пределах free-tier 1000.
const CTX_TTL_SEC = 30 * 86400;

function ctxKey(orderId: number): string {
  return `ctx:order:${orderId}`;
}

export async function loadOrderContext(
  env: Env,
  orderId: number
): Promise<OrderContext | null> {
  let raw: string | null = null;
  try {
    raw = await env.ORDERS_KV.get(ctxKey(orderId));
  } catch (e) {
    console.warn("loadOrderContext: KV get failed", orderId, String(e));
    return null;
  }
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as OrderContext;
  } catch {
    // Битая запись не должна ломать отклик — трактуем как отсутствие контекста.
    console.warn("loadOrderContext: broken JSON, ignoring", orderId);
    return null;
  }
}

export async function updateOrderContext(
  env: Env,
  orderId: number,
  patch: Partial<OrderContext>
): Promise<void> {
  const existing = await loadOrderContext(env, orderId);
  const now = Date.now();
  const next: OrderContext = {
    order: patch.order ?? existing?.order!,
    score: patch.score ?? existing?.score!,
    draftMessages: patch.draftMessages ?? existing?.draftMessages ?? [],
    humanizeMessages: patch.humanizeMessages ?? existing?.humanizeMessages ?? [],
    bidText: patch.bidText !== undefined ? patch.bidText : (existing?.bidText ?? null),
    createdTs: existing?.createdTs ?? now,
    updatedTs: now,
  };
  try {
    await env.ORDERS_KV.put(ctxKey(orderId), JSON.stringify(next), {
      expirationTtl: CTX_TTL_SEC,
    });
  } catch (e) {
    // KV-ошибка не должна ронять отклик — контекст опционален.
    console.warn("updateOrderContext: KV put failed", orderId, String(e));
  }
}
