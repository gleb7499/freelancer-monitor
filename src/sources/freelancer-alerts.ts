import type { Env } from "../types";
import { getConfig } from "../config";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15000;
const ALERTS_URL =
  "https://www.freelancer.com/ajax-api/navigation/recent-saved-search-alerts.php";

const CURSOR_KEY = "alerts:last_ts";
const AUTH_KEY = "fl:auth";

export interface AlertLead {
  projectId: number;
  title: string;
  seoUrl: string;
  time: number;
}

export interface AlertLeadsResult {
  leads: AlertLead[];
  error: string | null;
  authFailed: boolean;
}

interface AlertsResponseItem {
  type?: string;
  project_id?: number;
  project_title?: string;
  project_seo_url?: string;
  time_updated?: number;
}

interface AlertsResponse {
  status?: string;
  error?: { code?: string };
  result?: AlertsResponseItem[];
}

export async function resolveAuth(env: Env): Promise<{ userId: string; hash: string } | null> {
  try {
    const raw = await env.ORDERS_KV.get(AUTH_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { userId?: unknown; hash?: unknown };
      if (typeof parsed.userId === "string" && typeof parsed.hash === "string") {
        return { userId: parsed.userId, hash: parsed.hash };
      }
    }
  } catch (e) {
    console.error("fl:auth KV read failed:", e);
  }
  const cfg = getConfig(env);
  if (cfg.flUserId === "" || cfg.flAuthHash === "") return null;
  return { userId: cfg.flUserId, hash: cfg.flAuthHash };
}

export async function fetchAlertLeads(env: Env): Promise<AlertLeadsResult> {
  const empty: AlertLeadsResult = { leads: [], error: null, authFailed: false };

  const auth = await resolveAuth(env);
  if (auth === null) {
    return { ...empty, error: "no freelancer auth configured" };
  }

  const cursorRaw = await env.ORDERS_KV.get(CURSOR_KEY);
  // Bootstrap: первый тик после деплоя — ставим курсор на now, не тащим бэклог.
  if (cursorRaw === null) {
    await env.ORDERS_KV.put(CURSOR_KEY, String(Math.floor(Date.now() / 1000)));
    return empty;
  }
  const lastTs = Number(cursorRaw);
  if (!Number.isFinite(lastTs)) {
    await env.ORDERS_KV.put(CURSOR_KEY, String(Math.floor(Date.now() / 1000)));
    return empty;
  }

  let response: Response;
  try {
    response = await fetch(ALERTS_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        accept: "application/json",
        "freelancer-app-name": "main",
        "freelancer-app-platform": "web",
        "freelancer-auth-v2": `${auth.userId};${auth.hash}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ...empty, error: `alerts fetch failed: ${String(e)}` };
  }

  if (response.status === 401) {
    return { ...empty, authFailed: true };
  }
  if (!response.ok) {
    return { ...empty, error: `alerts HTTP ${response.status}` };
  }

  let data: AlertsResponse;
  try {
    data = (await response.json()) as AlertsResponse;
  } catch (e) {
    return { ...empty, error: `alerts invalid JSON: ${String(e)}` };
  }

  if (data.status !== "success" || !Array.isArray(data.result)) {
    if (data.error?.code === "UNAUTHORIZED") {
      return { ...empty, authFailed: true };
    }
    return { ...empty, error: `alerts API status: ${data.status ?? "unknown"}` };
  }

  const leads: AlertLead[] = [];
  let maxTs = lastTs;
  for (const item of data.result) {
    if (item.type !== "single") continue;
    if (typeof item.project_id !== "number" || typeof item.time_updated !== "number") continue;
    if (item.time_updated <= lastTs) continue;
    leads.push({
      projectId: item.project_id,
      title: item.project_title ?? "",
      seoUrl: item.project_seo_url ?? "",
      time: item.time_updated,
    });
    if (item.time_updated > maxTs) maxTs = item.time_updated;
  }

  // Курсор пишем только при новых алертах — иначе 1440 KV put/сутки
  // (тик каждую минуту) съедают free-лимит 1000 put/сутки.
  if (maxTs > lastTs) {
    await env.ORDERS_KV.put(CURSOR_KEY, String(maxTs));
  }
  return { leads, error: null, authFailed: false };
}
