import type { Env, Order } from "../types";
import { getConfig } from "../config";
import { normalizeProject, type FreelancerProject } from "../parser";

// Официальный intake: публичный API projects/active (без auth, без кук).
// Те же фильтры, что у saved search «Main Search»: 11 скиллов, fixed+hourly,
// английский, сортировка по свежести. Курсор — по submitdate (unix sec).
// Опрос — каждый тик DO (10 с); throttle защищает от двойных запросов внутри тика.
const SKILLS = [9, 323, 607, 741, 759, 979, 1002, 1042, 2370, 2376, 2703];
const FETCH_TIMEOUT_MS = 15000;
const POLL_MIN_INTERVAL_MS = 10_000;
const LIMIT = 25;
const CURSOR_KEY = "active:last_submit";
const LAST_FETCH_KEY = "active:last_fetch";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Тело проекта — подмножество полей parser.FreelancerProject; normalizeProject
// защищённо обрабатывает отсутствующие поля.
interface ActiveResponse {
  status?: string;
  result?: { projects?: unknown[] };
}

export interface ActiveOrdersResult {
  orders: Order[];
  skipped: boolean;
  error: string | null;
}

export async function fetchActiveOrders(env: Env): Promise<ActiveOrdersResult> {
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
    console.warn("active throttle check failed:", e);
  }

  let cursorRaw: string | null = null;
  try {
    cursorRaw = await env.ORDERS_KV.get(CURSOR_KEY);
  } catch (e) {
    console.warn("active cursor read failed:", e);
  }
  // Bootstrap: первый запуск — берём заказы за последние 5 минут
  // (не заваливаем LLM суточным бэклогом, но сразу видно, что канал жив).
  const lastSubmit = cursorRaw === null ? Math.floor(Date.now() / 1000) - 300 : Number(cursorRaw);

  const cfg = getConfig(env);
  const url = new URL(`${cfg.freelancerBase}/projects/active/`);
  for (const id of SKILLS) url.searchParams.append("jobs[]", String(id));
  url.searchParams.append("project_types[]", "fixed");
  url.searchParams.append("project_types[]", "hourly");
  url.searchParams.append("languages[]", "en");
  url.searchParams.set("sort_field", "submitdate");
  url.searchParams.set("limit", String(LIMIT));
  url.searchParams.set("full_description", "true");
  url.searchParams.set("compact", "true");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ...empty, error: `active fetch failed: ${String(e)}` };
  }
  if (!response.ok) {
    return { ...empty, error: `active HTTP ${response.status}` };
  }

  let data: ActiveResponse;
  try {
    data = (await response.json()) as ActiveResponse;
  } catch (e) {
    return { ...empty, error: `active invalid JSON: ${String(e)}` };
  }
  if (data.status !== "success" || !data.result) {
    return { ...empty, error: `active API status: ${data.status ?? "unknown"}` };
  }

  const orders: Order[] = [];
  let maxSubmit = lastSubmit;
  for (const raw of data.result.projects ?? []) {
    const project = raw as FreelancerProject;
    const submit = typeof project.submitdate === "number" ? project.submitdate : 0;
    if (submit <= lastSubmit) continue;
    const order = normalizeProject(project, "active");
    order.source = "active";
    orders.push(order);
    if (submit > maxSubmit) maxSubmit = submit;
  }

  // Курсор двигаем только при росте — иначе 1440 put/сутки (KV).
  if (maxSubmit > lastSubmit) {
    try {
      await env.ORDERS_KV.put(CURSOR_KEY, String(maxSubmit), { expirationTtl: 7 * 86400 });
    } catch (e) {
      console.warn("active cursor put failed:", e);
    }
  }
  return { orders, skipped: false, error: null };
}
