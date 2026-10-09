import type { Env } from "./types";
import { getConfig } from "./config";

export interface WebAuth {
  userId: string;
  hash: string;
}

// Разрешает веб-авторизацию freelancer-auth-v2: KV `fl:auth`
// (горячая замена через /admin/fl-auth) перекрывает env-секреты.
export async function resolveWebAuth(env: Env): Promise<WebAuth | null> {
  try {
    const raw = await env.ORDERS_KV.get("fl:auth");
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { userId?: unknown; hash?: unknown };
      if (typeof parsed.userId === "string" && typeof parsed.hash === "string") {
        return { userId: parsed.userId, hash: parsed.hash };
      }
    }
  } catch (e) {
    console.warn("fl:auth KV read failed:", e);
  }
  const cfg = getConfig(env);
  if (cfg.flUserId === "" || cfg.flAuthHash === "") return null;
  return { userId: cfg.flUserId, hash: cfg.flAuthHash };
}

// Заголовки для всех закрытых веб-вызовов Freelancer (эмуляция фронта).
export function webAuthHeaders(auth: WebAuth): Record<string, string> {
  return {
    accept: "application/json",
    "freelancer-app-name": "main",
    "freelancer-app-platform": "web",
    "freelancer-auth-v2": `${auth.userId};${auth.hash}`,
  };
}

export function isUnauthorizedStatus(status: number): boolean {
  return status === 401;
}

// data — распарсенное тело ответа; true если error.code === "UNAUTHORIZED".
export function isUnauthorizedBody(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const err = (data as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === "UNAUTHORIZED";
}

// Браузерный User-Agent, общий для всех веб-вызовов.
export const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
