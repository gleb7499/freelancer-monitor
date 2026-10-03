import type { Env, Order, OwnerInfo } from "./types";
import { getConfig } from "./config";
import { normalizeProject } from "./parser";

// Пользовательский API Freelancer. В wrangler.toml не вынесен сознательно
// (одна константа, вторая база рядом с projects/0.1) — оставляем здесь.
// Проверено live 2026-10-03: GET /api/users/0.1/users/{id} работает без авторизации.
const USERS_API_BASE = "https://www.freelancer.com/api/users/0.1";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15000;

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

export type { OwnerInfo };

// GET /api/users/0.1/users/{id}?reputation=true&employer_reputation=true&compact=true
// Поля reputation.* / employer_reputation.* приходят только с флагами
// reputation=true / employer_reputation=true (проверено live 2026-10-03).
// payment_verified и открытые заказы анонимно недоступны — null.
export async function fetchOwnerInfo(env: Env, ownerId: number): Promise<OwnerInfo | null> {
  const url = new URL(`${USERS_API_BASE}/users/${ownerId}`);
  url.searchParams.set("reputation", "true");
  url.searchParams.set("employer_reputation", "true");
  url.searchParams.set("compact", "true");

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`fetchOwnerInfo: HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    status?: string;
    result?: {
      id?: number;
      username?: string | null;
      reputation?: {
        entire_history?: {
          overall?: number | null;
          reviews?: number | null;
          completion_rate?: number | null;
          rehire_rate?: number | null;
        } | null;
      } | null;
      employer_reputation?: {
        entire_history?: {
          overall?: number | null;
          complete?: number | null;
          rehire_rate?: number | null;
        } | null;
      } | null;
    };
  };
  if (data.status !== "success" || !data.result) return null;
  const r = data.result;
  const rh = r.reputation?.entire_history ?? undefined;
  const eh = r.employer_reputation?.entire_history ?? undefined;
  return {
    id: r.id ?? ownerId,
    username: r.username ?? null,
    reputation_overall: rh?.overall ?? null,
    reviews: rh?.reviews ?? null,
    completion_rate: rh?.completion_rate ?? null,
    rehire_rate: rh?.rehire_rate ?? null,
    employer_overall: eh?.overall ?? null,
    employer_complete: eh?.complete ?? null,
    employer_rehire_rate: eh?.rehire_rate ?? null,
    payment_verified: null,
    open_projects: null,
  };
}
