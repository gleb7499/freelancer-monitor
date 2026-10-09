import type { Env, Order } from "../types";
import { getConfig } from "../config";
import { normalizeProject } from "../parser";
import { WEB_USER_AGENT } from "../web-auth";
import {
  mapCardToProject,
  ownerIdFromCard,
  type ActiveOrdersResult,
} from "./freelancer-active";

// Публичный intake: тот запрос, который делает страница поиска фронта,
// GET {freelancerBase}/projects/active. Точка публичная — без freelancer-auth-v2
// и без кук отдаёт 200 и полный JSON; элементы — полные карточки (37 полей),
// дозаполнение по id не нужно. Те же 11 скиллов, что у ленты и saved search.
// Курсор — по submitdate элемента (unix sec), опрос каждый тик DO (10 с),
// throttle защищает от двойных запросов внутри тика.
const SKILLS = [9, 323, 607, 741, 759, 979, 1002, 1042, 2370, 2376, 2703];
const FETCH_TIMEOUT_MS = 15000;
const POLL_MIN_INTERVAL_MS = 10_000;
const CURSOR_KEY = "search:last_submit";
const LAST_FETCH_KEY = "search:last_fetch";
// Лимит страницы поиска — защита от всплеска выдачи.
const MAX_CARDS_PER_TICK = 20;

// Массив карточек из тела ответа. Защищённо принимает конверт
// {status, result:{projects:[...]}}. Иначе [].
export function parseSearchBody(data: unknown): unknown[] {
  if (typeof data !== "object" || data === null) return [];
  const result = (data as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return [];
  const projects = (result as { projects?: unknown }).projects;
  return Array.isArray(projects) ? projects : [];
}

export async function fetchSearchOrders(env: Env): Promise<ActiveOrdersResult> {
  const empty: ActiveOrdersResult = { orders: [], skipped: false, error: null };

  // Throttle: защита от повторного запроса внутри одного тика (DO тикает каждые 10 с).
  try {
    const lastFetchRaw = await env.ORDERS_KV.get(LAST_FETCH_KEY);
    const lastFetch = lastFetchRaw === null ? 0 : Number(lastFetchRaw);
    if (Number.isFinite(lastFetch) && Date.now() - lastFetch < POLL_MIN_INTERVAL_MS) {
      return { ...empty, skipped: true };
    }
    await env.ORDERS_KV.put(LAST_FETCH_KEY, String(Date.now()), { expirationTtl: 86400 });
  } catch (e) {
    console.warn("search throttle check failed:", e);
  }

  let cursorRaw: string | null = null;
  try {
    cursorRaw = await env.ORDERS_KV.get(CURSOR_KEY);
  } catch (e) {
    console.warn("search cursor read failed:", e);
  }
  // Bootstrap: первый запуск — берём заказы за последние 5 минут
  // (не заваливаем LLM суточным бэклогом, но сразу видно, что канал жив).
  const lastSubmit = cursorRaw === null ? Math.floor(Date.now() / 1000) - 300 : Number(cursorRaw);

  const cfg = getConfig(env);
  const url = new URL(`${cfg.freelancerBase}/projects/active`);
  url.searchParams.set("limit", "20");
  url.searchParams.set("full_description", "true");
  url.searchParams.set("job_details", "true");
  url.searchParams.set("upgrade_details", "true");
  url.searchParams.set("owner_info", "true");
  for (const id of SKILLS) url.searchParams.append("jobs[]", String(id));
  url.searchParams.append("languages[]", "en");
  url.searchParams.append("project_types[]", "hourly");
  url.searchParams.append("project_types[]", "fixed");
  url.searchParams.set("sort_field", "submitdate");
  url.searchParams.set("webapp", "1");
  url.searchParams.set("compact", "true");
  url.searchParams.set("new_errors", "true");
  url.searchParams.set("new_pools", "true");

  let response: Response;
  try {
    // Точка публичная: только браузерный User-Agent, авторизация не нужна.
    response = await fetch(url.toString(), {
      headers: { "User-Agent": WEB_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ...empty, error: `search fetch failed: ${String(e)}` };
  }
  if (!response.ok) {
    return { ...empty, error: `search HTTP ${response.status}` };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (e) {
    return { ...empty, error: `search invalid JSON: ${String(e)}` };
  }
  const status = (data as { status?: unknown }).status;
  if (status !== "success") {
    return { ...empty, error: `search API status: ${status ?? "unknown"}` };
  }

  // Свежие карточки (submitdate строго больше курсора). Курсор двигаем по
  // max(submitdate) всех карточек — включая пропущенные, чтобы не сканировать
  // их повторно.
  const fresh: { card: unknown; submit: number }[] = [];
  let maxSubmit = lastSubmit;
  for (const card of parseSearchBody(data)) {
    if (typeof card !== "object" || card === null) continue;
    const submitNum = Number((card as { submitdate?: unknown }).submitdate);
    if (!Number.isFinite(submitNum)) continue;
    if (submitNum > maxSubmit) maxSubmit = submitNum;
    if (submitNum <= lastSubmit) continue;
    fresh.push({ card, submit: submitNum });
  }

  const orders: Order[] = [];
  let skippedLang = 0;
  for (const { card } of fresh.slice(0, MAX_CARDS_PER_TICK)) {
    const project = mapCardToProject(card);
    if (project === null) continue;
    // type !== fixed/hourly пропускаем: конкурсы и прочее конвейеру не нужны.
    // Проверяем СЫРОЕ поле карточки: normalizeProject коерцит любой не-hourly
    // тип в "fixed", поэтому гвард по Order.type был бы мёртвым кодом.
    const rawType = (project as { type?: unknown }).type;
    if (rawType !== "fixed" && rawType !== "hourly") continue;
    const order = normalizeProject(project, "active");
    // Страховка: языковой фильтр и так в параметрах, но API мог отдать другое.
    if (order.language !== "en") {
      skippedLang += 1;
      continue;
    }
    // Фолбэка у элемента поиска нет (userId у ленты) — null допустим.
    order.owner_id = ownerIdFromCard(card);
    orders.push(order);
  }
  if (fresh.length > 0) {
    console.log(
      JSON.stringify({
        step: "search.feed",
        fresh: fresh.length,
        skippedLang,
        orders: orders.length,
      }),
    );
  }

  // Курсор двигаем только при росте — иначе лишние put в KV.
  if (maxSubmit > lastSubmit) {
    try {
      await env.ORDERS_KV.put(CURSOR_KEY, String(maxSubmit), { expirationTtl: 7 * 86400 });
    } catch (e) {
      console.warn("search cursor put failed:", e);
    }
  }
  return { orders, skipped: false, error: null };
}
