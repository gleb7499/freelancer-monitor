import type { Env } from "./types";

// Режим авто-ставок. Хранится в KV ключе `mode` (JSON-строка).
// test — ставки не отправляются (лог only); live — реальный POST через OAuth;
// off — автоставки выключены.
export type Mode = "test" | "live" | "off";

const KV_KEY = "mode";
const DEFAULT_MODE: Mode = "test";

export async function getMode(env: Env): Promise<Mode> {
  try {
    const raw = await env.ORDERS_KV.get(KV_KEY);
    if (raw === "test" || raw === "live" || raw === "off") return raw;
  } catch (e) {
    console.warn("getMode: KV read failed, defaulting to test", String(e));
  }
  return DEFAULT_MODE;
}

export async function setMode(env: Env, mode: Mode): Promise<void> {
  await env.ORDERS_KV.put(KV_KEY, mode);
}
