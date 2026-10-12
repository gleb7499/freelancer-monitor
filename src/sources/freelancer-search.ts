import type { Env, Order } from "../types";
import type { Channel } from "../channels";
import { getConfig } from "../config";
import { normalizeProject } from "../parser";
import { WEB_USER_AGENT } from "../web-auth";
import {
  mapCardToProject,
  ownerIdFromCard,
  type ActiveOrdersResult,
  type ChannelState,
  kvChannelState,
} from "./freelancer-active";

// Публичный intake канала поиска: тот запрос, который делает страница поиска
// фронта, GET {freelancerBase}/projects/active. Точка публичная — без
// freelancer-auth-v2 и без кук отдаёт 200 и полный JSON; элементы — полные
// карточки (37 полей), дозаполнение по id не нужно. Скиллы/языки/типы берутся
// из спецификации канала (channel.searches[0]).
// Курсор — по submitdate элемента (unix sec), опрос каждый тик DO (10 с),
// throttle (5 с) защищает от двойных запросов внутри длинного тика.
// Ключи KV параметризованы каналом: search:${channel.id}:last_submit и
// search:${channel.id}:last_fetch.
const FETCH_TIMEOUT_MS = 15000;
const POLL_MIN_INTERVAL_MS = 5_000;
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

export async function fetchSearchOrders(
  env: Env,
  channel: Channel,
  state: ChannelState = kvChannelState(env),
): Promise<ActiveOrdersResult> {
  const empty: ActiveOrdersResult = { orders: [], skipped: false, error: null };

  const spec = channel.searches[0];
  if (spec === undefined) {
    console.warn(`search channel ${channel.id}: нет спецификаций поиска (searches пуст)`);
    return empty;
  }

  const cursorKey = `search:${channel.id}:last_submit`;
  const lastFetchKey = `search:${channel.id}:last_fetch`;

  // Throttle: защита от повторного запроса внутри одного тика (DO тикает каждые 10 с).
  try {
    const lastFetchRaw = await state.get(lastFetchKey);
    const lastFetch = lastFetchRaw === null ? 0 : Number(lastFetchRaw);
    if (Number.isFinite(lastFetch) && Date.now() - lastFetch < POLL_MIN_INTERVAL_MS) {
      return { ...empty, skipped: true };
    }
    await state.put(lastFetchKey, String(Date.now()), 86400);
  } catch (e) {
    console.warn("search throttle check failed:", e);
  }

  let cursorRaw: string | null = null;
  try {
    cursorRaw = await state.get(cursorKey);
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
  for (const id of spec.skills) url.searchParams.append("jobs[]", String(id));
  for (const lang of spec.languages) url.searchParams.append("languages[]", lang);
  for (const pt of spec.projectTypes) url.searchParams.append("project_types[]", pt);
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
    const order = normalizeProject(project, `search:${channel.id}`);
    order.channel = channel.id === "android" ? "android" : "main";
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
      await state.put(cursorKey, String(maxSubmit), 7 * 86400);
    } catch (e) {
      console.warn("search cursor put failed:", e);
    }
  }
  return { orders, skipped: false, error: null };
}
