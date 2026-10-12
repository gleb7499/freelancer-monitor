import type { Env } from "./types";
import { getConfig } from "./config";
import { WEB_USER_AGENT, resolveWebAuth, webAuthHeaders } from "./web-auth";
import { getChannels } from "./channels";

const CACHE_KEY = "profiles:map";
const CACHE_TTL_S = 3600;

interface ProfileEntry {
  id?: unknown;
  user_id?: unknown;
  profile_name?: unknown;
  status?: unknown;
}

// Мапа «имя профиля → числовой id» по активным профилям аккаунта. Закрытый
// веб-вызов (freelancer-auth-v2), тот же паттерн, что в enrich.ts. Кэш в
// KV `profiles:map` на 1 ч. Любые ошибки авторизации/сети → null (не бросает).
export async function fetchProfileMap(env: Env): Promise<Record<string, number> | null> {
  try {
    const cached = await env.ORDERS_KV.get(CACHE_KEY);
    if (cached !== null) return JSON.parse(cached) as Record<string, number>;
  } catch {
    // кэш недоступен — идём в API
  }

  const cfg = getConfig(env);
  const auth = await resolveWebAuth(env);
  if (auth === null || cfg.flUserId === "") return null;
  try {
    const url = new URL("https://www.freelancer.com/api/users/0.1/profiles");
    url.searchParams.set("user_id", cfg.flUserId);
    url.searchParams.set("webapp", "1");
    url.searchParams.set("compact", "true");
    url.searchParams.set("new_errors", "true");
    url.searchParams.set("new_pools", "true");
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": WEB_USER_AGENT, ...webAuthHeaders(auth) },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { profiles?: unknown } };
    const profiles = data.result?.profiles;
    const list: ProfileEntry[] = Array.isArray(profiles)
      ? profiles
      : typeof profiles === "object" && profiles !== null
        ? Object.values(profiles as Record<string, ProfileEntry>)
        : [];
    const map: Record<string, number> = {};
    for (const p of list) {
      if (
        typeof p.id === "number" &&
        typeof p.profile_name === "string" &&
        p.status === "active"
      ) {
        map[p.profile_name] = p.id;
      }
    }
    try {
      await env.ORDERS_KV.put(CACHE_KEY, JSON.stringify(map), { expirationTtl: CACHE_TTL_S });
    } catch {
      // запись в кэш не критична
    }
    return map;
  } catch {
    return null;
  }
}

// Разрешает имя профиля в числовой id. null у общей ленты (feed) — без поля
// profile_id в ставке. При неудаче API — подсказка profileIdHint из реестра
// каналов (перебор getChannels по profileName).
export async function resolveProfileId(env: Env, profileName: string | null): Promise<number | null> {
  if (profileName === null) return null;
  const map = await fetchProfileMap(env);
  const fromApi = map?.[profileName];
  if (typeof fromApi === "number") return fromApi;
  const channel = getChannels(env).find((ch) => ch.profileName === profileName);
  return channel?.profileIdHint ?? null;
}
