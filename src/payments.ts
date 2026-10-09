import type { WebAuth } from "./web-auth";
import { webAuthHeaders } from "./web-auth";

// Покупка апгрейда Sealed ($0.10) через корзину платежей Freelancer.
// Работает ТОЛЬКО с веб-авторизацией freelancer-auth-v2 (проверено живым
// запросом 09.10.2026); OAuth/Bearer здесь не принимаются.
// Три шага: создать корзину → добавить позицию sealed → провести оплату.
// Деньги списываются на третьем шаге (action:"process").

// База платёжного API — отдельный префикс /api/payments/0.1 на том же хосте,
// не совпадает с freelancerBase из настроек (тот — /api/... для проектов).
const PAYMENTS_BASE = "https://www.freelancer.com/api/payments/0.1";

// USD: подтверждён живым ответом /api/projects/0.1/currencies (id=1).
const USD_CURRENCY_ID = 1;

// Sealed в enum апгрейдов фронта (JS-бандл): sponsored=1, highlight=2, sealed=3.
const SEALED_CONTEXT_SUB_TYPE = 3;

const SEALED_PRICE = 0.1;

export async function buySealedUpgrade(
  auth: WebAuth,
  bidId: number,
  projectId: number,
): Promise<"ok" | string> {
  const headers = { ...webAuthHeaders(auth), "Content-Type": "application/json" };
  try {
    // 1. Корзина: return_action вернёт нас на страницу проекта после оплаты.
    const cartRes = await fetch(`${PAYMENTS_BASE}/carts/`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        return_action: {
          destination: "project_view_page",
          payload: String(projectId),
        },
        description: `Bid upgrade for ${bidId}`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!cartRes.ok) return await errorText(cartRes);
    const cartId = ((await cartRes.json()) as { result?: { id?: number } }).result?.id;
    if (cartId === undefined) return "no-cart-id";

    // 2. Позиция корзины: апгрейд sealed для ставки.
    const itemRes = await fetch(`${PAYMENTS_BASE}/carts/${cartId}/cart_items/`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        context_type: "bid_upgrade",
        context_id: String(bidId),
        description: "Sealed Upgrade",
        currency: USD_CURRENCY_ID,
        amount: SEALED_PRICE,
        cart_id: cartId,
        context_sub_type: SEALED_CONTEXT_SUB_TYPE,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!itemRes.ok) return await errorText(itemRes);

    // 3. Проведение: именно здесь списываются деньги.
    const processRes = await fetch(`${PAYMENTS_BASE}/carts/${cartId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ action: "process" }),
      signal: AbortSignal.timeout(20000),
    });
    if (!processRes.ok) return await errorText(processRes);
    return "ok";
  } catch (e) {
    return String(e).slice(0, 100);
  }
}

// Код ошибки из тела ответа (error_code, иначе message), иначе http-<статус>.
async function errorText(res: Response): Promise<string> {
  const text = (await res.text()).slice(0, 300);
  try {
    const data = JSON.parse(text) as { error_code?: unknown; message?: unknown };
    const code =
      typeof data.error_code === "string" && data.error_code !== ""
        ? data.error_code
        : typeof data.message === "string" && data.message !== ""
          ? data.message
          : null;
    return (code ?? `http-${res.status}`).slice(0, 100);
  } catch {
    return `http-${res.status}`;
  }
}
