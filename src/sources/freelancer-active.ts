import type { Env, Order } from "../types";
import { getConfig } from "../config";
import { normalizeProject, type FreelancerProject } from "../parser";
import {
  isUnauthorizedBody,
  isUnauthorizedStatus,
  resolveWebAuth,
  webAuthHeaders,
  WEB_USER_AGENT,
} from "../web-auth";

// Закрытый intake общего feed-канала: веб-лента
// navigation/project-feed/pre-populated.php (эмуляция фронта заголовком
// freelancer-auth-v2, без кук). Скиллы ниже — параметры самого эндпоинта
// ленты (jobIds[]), а не фильтр поиска; source у заказов ленты — "feed",
// order.channel не заполняется (null — профиль выбирает LLM при скоринге).
// Курсор — по time элемента ленты (unix sec).
// Опрос — каждый тик DO (10 с); throttle (5 с) защищает от двойных запросов
// внутри длинного тика и от частоты выше разумной для платформы.
// Новые элементы ленты — компактные; полные карточки догружаются из
// projects/0.1/projects (mapCardToProject) и нормализуются через normalizeProject.
import { MAIN_SKILLS } from "../channels";

const FETCH_TIMEOUT_MS = 15000;
const POLL_MIN_INTERVAL_MS = 5_000;
const CURSOR_KEY = "active:last_submit";
const LAST_FETCH_KEY = "active:last_fetch";
// Максимум карточек за тик — защита от всплеска ленты.
const MAX_CARDS_PER_TICK = 10;

export interface ActiveOrdersResult {
  orders: Order[];
  skipped: boolean;
  error: string | null;
}

// Адаптер хранилища состояния канала (курсоры, throttle). По умолчанию —
// обёртка над env.ORDERS_KV; ChannelRunner передаёт адаптер над своим
// ctx.storage, чтобы состояние канала жило в рамках его потока (DO).
export interface ChannelState {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSec?: number): Promise<void>;
}

export function kvChannelState(env: Env): ChannelState {
  return {
    get: (key) => env.ORDERS_KV.get(key),
    put: (key, value, ttlSec) =>
      env.ORDERS_KV.put(key, value, ttlSec !== undefined ? { expirationTtl: ttlSec } : undefined),
  };
}

// Массив элементов ленты из тела ответа. Защищённо принимает конверт
// {status, result:[...]}, альтернативный конверт {result:{projects:[...]}}
// и голый массив. Иначе [].
export function parseFeedBody(data: unknown): unknown[] {
  if (typeof data !== "object" || data === null) return [];
  const result = (data as { result?: unknown }).result;
  if (Array.isArray(result)) return result;
  if (typeof result === "object" && result !== null) {
    const projects = (result as { projects?: unknown }).projects;
    if (Array.isArray(projects)) return projects;
  }
  if (Array.isArray(data)) return data;
  return [];
}

// owner_id из полной карточки: owner_info.id ?? owner_info.user_id ??
// owner_info.owner_id, коерция через Number. Валидное положительное число →
// число, иначе null. Общий для обоих каналов (лента и публичный поиск).
export function ownerIdFromCard(card: unknown): number | null {
  if (typeof card !== "object" || card === null) return null;
  const ownerInfo = (card as { owner_info?: Record<string, unknown> }).owner_info;
  if (typeof ownerInfo !== "object" || ownerInfo === null) return null;
  const ownerRaw = ownerInfo.id ?? ownerInfo.user_id ?? ownerInfo.owner_id;
  const ownerNum = Number(ownerRaw);
  return Number.isFinite(ownerNum) && ownerNum > 0 ? ownerNum : null;
}

// Элемент ленты → {id, time, ownerId, kind}. id и time обязательны
// (терпим строки — API отдаёт unix в строках), иначе null;
// ownerId из userId, kind из type ("project"/"contest", иначе "project").
export function mapFeedItem(
  item: unknown,
): { id: number; time: number; ownerId: number | null; kind: string } | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as { id?: unknown; time?: unknown; userId?: unknown; type?: unknown };
  const id = Number(obj.id);
  const time = Number(obj.time);
  const ownerNum = Number(obj.userId);
  if (!Number.isFinite(id) || !Number.isFinite(time)) return null;
  return {
    id,
    time,
    ownerId: Number.isFinite(ownerNum) && ownerNum > 0 ? ownerNum : null,
    kind: typeof obj.type === "string" ? obj.type : "project",
  };
}

// Карточка из projects/0.1/projects → объект формы FreelancerProject.
// Отличие конверта: active_prepaid_milestone лежит ВНУТРИ upgrades —
// поднимаем его в верхний уровень (шим для normalizeProject).
// Невалидная карточка (нет id) → null.
export function mapCardToProject(card: unknown): FreelancerProject | null {
  if (typeof card !== "object" || card === null) return null;
  const obj = card as Record<string, unknown>;
  if (typeof obj.id !== "number") return null;
  const result: Record<string, unknown> = { ...obj };
  if (result.active_prepaid_milestone === undefined) {
    const upgrades = obj.upgrades;
    if (typeof upgrades === "object" && upgrades !== null) {
      const milestone = (upgrades as Record<string, unknown>).active_prepaid_milestone;
      if (milestone !== undefined) result.active_prepaid_milestone = milestone;
    }
  }
  return result as unknown as FreelancerProject;
}

async function fetchCard(env: Env, auth: { userId: string; hash: string }, id: number): Promise<FreelancerProject | null> {
  const cfg = getConfig(env);
  const url = new URL(`${cfg.freelancerBase}/projects`);
  url.searchParams.append("projects[]", String(id));
  url.searchParams.set("full_description", "true");
  url.searchParams.set("upgrade_details", "true");
  url.searchParams.set("job_details", "true");
  url.searchParams.set("owner_info", "true");
  url.searchParams.set("attachment_details", "true");
  url.searchParams.set("webapp", "1");
  url.searchParams.set("compact", "true");
  url.searchParams.set("new_errors", "true");
  url.searchParams.set("new_pools", "true");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { "User-Agent": WEB_USER_AGENT, ...webAuthHeaders(auth) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.warn(`active card ${id} fetch failed:`, e);
    return null;
  }
  if (!response.ok) {
    console.warn(`active card ${id} HTTP ${response.status}`);
    return null;
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (e) {
    console.warn(`active card ${id} invalid JSON:`, e);
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const result = (data as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return null;
  const projects = (result as { projects?: unknown }).projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    console.warn(`active card ${id}: empty projects in response`);
    return null;
  }
  return mapCardToProject(projects[0]);
}

export async function fetchActiveOrders(env: Env, state: ChannelState = kvChannelState(env)): Promise<ActiveOrdersResult> {
  const empty: ActiveOrdersResult = { orders: [], skipped: false, error: null };

  const auth = await resolveWebAuth(env);
  if (auth === null) {
    return { ...empty, error: "active: web auth not configured (fl:auth KV or FL_USER_ID/FL_AUTH_HASH)" };
  }

  // Throttle: защита от повторного запроса внутри одного тика (DO тикает каждые 10 с).
  try {
    const lastFetchRaw = await state.get(LAST_FETCH_KEY);
    const lastFetch = lastFetchRaw === null ? 0 : Number(lastFetchRaw);
    if (Number.isFinite(lastFetch) && Date.now() - lastFetch < POLL_MIN_INTERVAL_MS) {
      return { ...empty, skipped: true };
    }
    await state.put(LAST_FETCH_KEY, String(Date.now()), 86400);
  } catch (e) {
    console.warn("active throttle check failed:", e);
  }

  let cursorRaw: string | null = null;
  try {
    cursorRaw = await state.get(CURSOR_KEY);
  } catch (e) {
    console.warn("active cursor read failed:", e);
  }
  // Bootstrap: первый запуск — берём заказы за последние 5 минут
  // (не заваливаем LLM суточным бэклогом, но сразу видно, что канал жив).
  const lastSubmit = cursorRaw === null ? Math.floor(Date.now() / 1000) - 300 : Number(cursorRaw);

  // Веб-эндпоинт живёт вне базы REST: полный URL, не от freelancerBase.
  const url = new URL("https://www.freelancer.com/ajax-api/navigation/project-feed/pre-populated.php");
  for (const id of MAIN_SKILLS) url.searchParams.append("jobIds[]", String(id));
  url.searchParams.set("fromWebapp", "true");
  url.searchParams.set("compact", "true");
  url.searchParams.set("new_errors", "true");
  url.searchParams.set("new_pools", "true");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { "User-Agent": WEB_USER_AGENT, ...webAuthHeaders(auth) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ...empty, error: `active fetch failed: ${String(e)}` };
  }
  if (!response.ok) {
    return {
      ...empty,
      error: isUnauthorizedStatus(response.status)
        ? "active UNAUTHORIZED: freelancer-auth-v2 протух"
        : `active HTTP ${response.status}`,
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (e) {
    return { ...empty, error: `active invalid JSON: ${String(e)}` };
  }
  // Детект протухшей авторизации: не алертим здесь, только явная ошибка.
  if (isUnauthorizedBody(data)) {
    return { ...empty, error: "active UNAUTHORIZED: freelancer-auth-v2 протух" };
  }
  const status = (data as { status?: unknown }).status;
  if (status !== "success") {
    return { ...empty, error: `active API status: ${status ?? "unknown"}` };
  }

  // Новые элементы ленты (свежее курсора). Курсор двигаем по max(time)
  // всех элементов — включая конкурсы, чтобы не сканировать их повторно.
  const fresh: { id: number; time: number; ownerId: number | null }[] = [];
  let contests = 0;
  let maxSubmit = lastSubmit;
  for (const item of parseFeedBody(data)) {
    const mapped = mapFeedItem(item);
    if (mapped === null) continue;
    if (mapped.time > maxSubmit) maxSubmit = mapped.time;
    if (mapped.kind !== "project") {
      contests += 1;
      continue;
    }
    if (mapped.time <= lastSubmit) continue;
    fresh.push(mapped);
  }

  const orders: Order[] = [];
  let skippedLang = 0;
  for (const item of fresh.slice(0, MAX_CARDS_PER_TICK)) {
    const card = await fetchCard(env, auth, item.id);
    if (card === null) continue;
    const order = normalizeProject(card, "feed");
    // Паритет с бывшим фильтром languages[]=en: не-английские заказы
    // не скорим (LLM-правила и так дали бы PASS, но квота не бесконечна).
    if (order.language !== "en") {
      skippedLang += 1;
      continue;
    }
    order.owner_id = ownerIdFromCard(card) ?? item.ownerId;
    orders.push(order);
  }
  if (contests > 0 || fresh.length > 0) {
    console.log(
      JSON.stringify({
        step: "active.feed",
        fresh: fresh.length,
        contests,
        skippedLang,
        orders: orders.length,
      }),
    );
  }

  // Курсор двигаем только при росте — иначе 1440 put/сутки (KV).
  if (maxSubmit > lastSubmit) {
    try {
      await state.put(CURSOR_KEY, String(maxSubmit), 7 * 86400);
    } catch (e) {
      console.warn("active cursor put failed:", e);
    }
  }
  return { orders, skipped: false, error: null };
}
