import type { Env, Order, ProjectClientInfo } from "./types";
import { getConfig } from "./config";
import { normalizeProject } from "./parser";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15000;

// Открытые точки Freelancer API (без авторизации, нужен только User-Agent
// обычного браузера):
// - projects/0.1/projects/ — выдача проектов по id (fetchProjectsByIds);
// - projects/0.1/projects/seo — данные заказчика по seo_url: verification,
//   рейтинг работодателя, other_employer_jobs (проверено live 2026-10-04).
// Закрытые точки (Authorization: Bearer <FL_API_KEY>):
// - users/0.1/portfolios/?users[]=<id> — портфолио профиля (fetchPortfolio).

export interface PortfolioItem {
  id: number;
  title: string;
  description: string;
  // Прямая ссылка на элемент портфолио — в откликах ссылаемся ВСЕГДА на неё,
  // а не на профиль целиком (маршрут веб-приложения, проверено 04.10.2026).
  url: string | null;
}

export interface PortfolioInfo {
  username: string | null;
  items: PortfolioItem[];
}

const PORTFOLIO_CACHE_KEY = "portfolio:cache";
const PORTFOLIO_CACHE_TTL = 6 * 3600;
const DESCRIPTION_MAX = 700;

// Скилл "Cryptocurrency": ставки по таким проектам требуют верификации
// аккаунта (403 RESTRICTED_FROM_BIDDING_PREMIUM_VERIFIED_JOB, проверено
// 04.10.2026). Используется пре-гейтом до LLM.
export const CRYPTO_SKILL_ID = 2658;

// Портфолио профиля: title + обрезанное description (демо-ссылки живут внутри
// description и достаются LLM оттуда). Кэш KV на 6 ч — состав меняется редко.
// Любая ошибка → null (отклик пишется без портфолио-контекста).
export async function fetchPortfolio(env: Env): Promise<PortfolioInfo | null> {
  try {
    const cached = await env.ORDERS_KV.get(PORTFOLIO_CACHE_KEY);
    if (cached !== null) {
      return JSON.parse(cached) as PortfolioInfo;
    }
  } catch {
    // кэш недоступен — идём в API
  }

  const cfg = getConfig(env);
  const authHeaders: Record<string, string> = cfg.flApiKey
    ? { Authorization: `Bearer ${cfg.flApiKey}` }
    : {};
  let items: PortfolioItem[] = [];
  try {
    const url = new URL("https://www.freelancer.com/api/users/0.1/portfolios/");
    url.searchParams.set("users[]", cfg.flUserId);
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, ...authHeaders },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        status?: string;
        result?: { portfolios?: Record<string, unknown> };
      };
      const raw = data.result?.portfolios?.[cfg.flUserId];
      const arr = Array.isArray(raw) ? raw : [];
      items = arr
        .filter((it) => it && typeof it === "object")
        .map((it: any) => {
          const title = typeof it.title === "string" ? it.title : "";
          let description = typeof it.description === "string" ? it.description : "";
          if (description.length > DESCRIPTION_MAX) {
            description = description.slice(0, DESCRIPTION_MAX);
            const lastSpace = description.lastIndexOf(" ");
            if (lastSpace > DESCRIPTION_MAX / 2) description = description.slice(0, lastSpace);
            description += "…";
          }
          return { id: Number(it.id) || 0, title, description, url: null as string | null };
        })
        .filter((it) => it.id > 0 && it.title !== "");
    }
  } catch {
    return null;
  }
  if (items.length === 0) return null;

  // Username для прямых ссылок на элементы портфолио (анонимная точка users/{id}).
  // Маршрут элемента: /u/<username>/portfolio-item/<id> (проверено 04.10.2026).
  let username: string | null = null;
  try {
    const res = await fetch(
      `https://www.freelancer.com/api/users/0.1/users/${cfg.flUserId}?compact=true`,
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (res.ok) {
      const data = (await res.json()) as { status?: string; result?: { username?: unknown } };
      if (data.status === "success" && typeof data.result?.username === "string") {
        username = data.result.username;
      }
    }
  } catch {
    // username не критичен
  }
  if (username) {
    for (const it of items) {
      it.url = `https://www.freelancer.com/u/${username}/portfolio-item/${it.id}`;
    }
  }

  const info: PortfolioInfo = {
    username,
    items,
  };
  try {
    await env.ORDERS_KV.put(PORTFOLIO_CACHE_KEY, JSON.stringify(info), {
      expirationTtl: PORTFOLIO_CACHE_TTL,
    });
  } catch {
    // кэш не записался — не страшно
  }
  return info;
}


// Своя копия fetchProjectsByIds: источник истины здесь, parser.ts держит
// только normalizeProject.
export async function fetchProjectsByIds(env: Env, ids: number[]): Promise<Order[]> {
  if (ids.length === 0) return [];
  const config = getConfig(env);
  const url = new URL(`${config.freelancerBase}/projects/`);
  for (const id of ids) url.searchParams.append("projects[]", String(id));
  url.searchParams.set("full_description", "true");
  url.searchParams.set("compact", "true");

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`fetchProjectsByIds: HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    status?: string;
    result?: { projects?: Parameters<typeof normalizeProject>[0][] };
  };
  if (data.status !== "success" || !data.result) {
    throw new Error("fetchProjectsByIds: API status not success");
  }
  return (data.result.projects ?? []).map((project) => normalizeProject(project, "alerts"));
}

// GET /api/projects/0.1/projects/seo?seo_url=<slug>&webapp=1&compact=true
// Открытая точка: отдаёт result.client (verification, rating,
// registration_unixtime, address) и result.other_employer_jobs — другие
// открытые заказы работодателя (проверено live 2026-10-04).
// seoSlug — часть order.url после "https://www.freelancer.com/projects/".
// Любая ошибка (404, не-JSON, сеть) → null, не бросает.
export async function fetchProjectClient(env: Env, seoSlug: string): Promise<ProjectClientInfo | null> {
  const slug = seoSlug.startsWith("https://www.freelancer.com/projects/")
    ? seoSlug.slice("https://www.freelancer.com/projects/".length)
    : seoSlug;
  if (!slug) return null;

  const url = new URL("https://www.freelancer.com/api/projects/0.1/projects/seo");
  url.searchParams.set("seo_url", slug);
  url.searchParams.set("webapp", "1");
  url.searchParams.set("compact", "true");

  let data: {
    status?: string;
    result?: {
      client?: {
        registration_unixtime?: unknown;
        address?: { city?: unknown; country?: unknown; country_code?: unknown } | null;
        rating?: { average?: unknown; review_count?: unknown } | null;
        verification?: {
          payment_verified?: unknown;
          email_verified?: unknown;
          profile_complete?: unknown;
          phone_verified?: unknown;
          deposit_made?: unknown;
        } | null;
      } | null;
      other_employer_jobs?: unknown;
      skills?: unknown;
    } | null;
  };
  try {
    const response = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) return null;
    data = (await response.json()) as typeof data;
  } catch {
    return null;
  }
  if (data.status !== "success" || !data.result) return null;

  const client = data.result.client;
  if (!client) return null;

  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const otherJobs = data.result.other_employer_jobs;
  const skillsRaw = Array.isArray(data.result.skills) ? data.result.skills : [];
  const skillIds = skillsRaw
    .map((s) => (s && typeof s === "object" ? Number((s as { id?: unknown }).id) : NaN))
    .filter((n) => Number.isFinite(n) && n > 0);

  return {
    payment_verified: bool(client.verification?.payment_verified),
    deposit_made: bool(client.verification?.deposit_made),
    email_verified: bool(client.verification?.email_verified),
    phone_verified: bool(client.verification?.phone_verified),
    rating: num(client.rating?.average),
    review_count: num(client.rating?.review_count),
    registered_ts: num(client.registration_unixtime),
    country: typeof client.address?.country === "string" ? client.address.country : null,
    open_projects: Array.isArray(otherJobs) ? otherJobs.length : null,
    skill_ids: skillIds.length > 0 ? skillIds : null,
  };
}
