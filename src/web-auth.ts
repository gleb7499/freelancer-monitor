import type { Env } from "./types";
import { getConfig } from "./config";
import { alert } from "./telegram";

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

// ---------------------------------------------------------------------------
// Выключатель при протухшей веб-авторизации. Флаг в KV `fl:auth-state`:
// пока он стоит, поисковые каналы в live-режиме не опрашивают заказы и не
// тратят LLM (ставка всё равно упадёт на 401). Ставят: канал feed на 401 и
// bidder на 401. Снимают: успешный опрос feed (он же проба каждые ~10 с),
// POST /admin/fl-auth с новой сессией, либо истечение TTL.
// ---------------------------------------------------------------------------


const AUTH_STATE_KEY = "fl:auth-state";
// Флаг от feed живёт до успешного опроса feed (TTL — страховка). Флаг от
// bidder истекает быстро: feed может отвечать, а запись ставки отклоняться,
// тогда раз в 10 минут пробуем один заказ.
const FEED_STATE_TTL_SEC = 6 * 3600;
const BID_STATE_TTL_SEC = 600;

export type AuthInvalidSource = "feed" | "bid";

interface AuthState {
  invalid: boolean;
  source: AuthInvalidSource;
  since: number;
}

async function readAuthState(env: Env): Promise<AuthState | null> {
  try {
    const raw = await env.ORDERS_KV.get(AUTH_STATE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    if (parsed.invalid === true && (parsed.source === "feed" || parsed.source === "bid")) {
      return { invalid: true, source: parsed.source, since: Number(parsed.since) || 0 };
    }
  } catch (e) {
    console.warn("fl:auth-state read failed:", e);
  }
  return null;
}

export async function isAuthInvalid(env: Env): Promise<boolean> {
  return (await readAuthState(env)) !== null;
}

// Пометить сессию протухшей. Алерт — только при переходе в «протухла»
// (повторные пометки при уже стоящем флаге не пишут в KV и не алертят).
export async function markAuthInvalid(env: Env, source: AuthInvalidSource): Promise<void> {
  const existing = await readAuthState(env);
  if (existing !== null) return;
  const state: AuthState = { invalid: true, source, since: Date.now() };
  try {
    await env.ORDERS_KV.put(AUTH_STATE_KEY, JSON.stringify(state), {
      expirationTtl: source === "feed" ? FEED_STATE_TTL_SEC : BID_STATE_TTL_SEC,
    });
  } catch (e) {
    console.warn("fl:auth-state write failed:", e);
  }
  await alert(
    env,
    "Веб-авторизация Freelancer протухла (401): опрос заказов и LLM приостановлены, обнови через /admin/fl-auth",
    { key: "auth-expired", ttlSec: 3600 },
  );
}

// Снять флаг. onlyFeed: успешный опрос feed снимает только флаг, поставленный
// самим feed (флаг bidder снимается по TTL или заменой сессии).
export async function clearAuthInvalid(env: Env, opts: { onlyFeed?: boolean } = {}): Promise<boolean> {
  const existing = await readAuthState(env);
  if (existing === null) return false;
  if (opts.onlyFeed && existing.source !== "feed") return false;
  try {
    await env.ORDERS_KV.delete(AUTH_STATE_KEY);
  } catch (e) {
    console.warn("fl:auth-state delete failed:", e);
    return false;
  }
  return true;
}
