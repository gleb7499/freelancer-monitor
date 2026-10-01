import type { Env } from "./types";

const RING_KEY = "log:ring";
const RING_MAX = 200;
const RING_TTL = 604800;
const BEAT_KEY = "log:lastbeat";
const BEAT_TTL = 3600;
const BEAT_INTERVAL_MS = 15 * 60 * 1000;

const RING_STEPS = new Set([
  "llm.verdict",
  "order.notified",
  "order.error",
  "tick.done-nonquiet",
  "heartbeat",
]);

type Level = "info" | "warn" | "error";

interface RingEntry {
  ts: string;
  level: Level;
  step: string;
  data?: Record<string, unknown>;
}

function emit(level: Level, step: string, data?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, step, ...data };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function shouldRing(level: Level, step: string): boolean {
  return level === "warn" || level === "error" || RING_STEPS.has(step);
}

// Free tier KV — 1000 put/сутки, поэтому info-записи кольца буферизуются
// в памяти изолята и сбрасываются одним put на тик (flushLogBuffer в конце
// runTick). Ошибки пишутся сразу — их мало.
const ringBuffer: RingEntry[] = [];

async function writeRing(env: Env, level: Level, step: string, data?: Record<string, unknown>): Promise<void> {
  try {
    const entry: RingEntry = { ts: new Date().toISOString(), level, step };
    if (data !== undefined) entry.data = data;
    let ring: unknown[] = [];
    const raw = await env.ORDERS_KV.get(RING_KEY);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) ring = parsed;
      } catch {
        // malformed ring — start fresh
      }
    }
    ring.push(entry);
    const trimmed = ring.slice(-RING_MAX);
    await env.ORDERS_KV.put(RING_KEY, JSON.stringify(trimmed), {
      expirationTtl: RING_TTL,
    });
  } catch (e) {
    console.error(`logger ring write failed: ${String(e)}`);
  }
}

export async function flushLogBuffer(env: Env): Promise<void> {
  if (ringBuffer.length === 0) return;
  const batch = ringBuffer.splice(0, ringBuffer.length);
  try {
    let ring: unknown[] = [];
    const raw = await env.ORDERS_KV.get(RING_KEY);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) ring = parsed;
      } catch {
        // malformed ring — start fresh
      }
    }
    ring.push(...batch);
    const trimmed = ring.slice(-RING_MAX);
    await env.ORDERS_KV.put(RING_KEY, JSON.stringify(trimmed), {
      expirationTtl: RING_TTL,
    });
  } catch (e) {
    console.error(`logger ring flush failed: ${String(e)}`);
  }
}

export function log(step: string, data?: Record<string, unknown>): void {
  emit("info", step, data);
}

export async function logImportant(env: Env, step: string, data?: Record<string, unknown>): Promise<void> {
  emit("info", step, data);
  if (shouldRing("info", step)) {
    ringBuffer.push({ ts: new Date().toISOString(), level: "info", step, ...(data ?? {}) });
  }
}

export async function logError(env: Env, step: string, data?: Record<string, unknown>): Promise<void> {
  emit("error", step, data);
  try {
    await writeRing(env, "error", step, data);
  } catch (e) {
    console.error(`logger ring write failed: ${String(e)}`);
  }
}

export async function heartbeat(env: Env, data?: Record<string, unknown>): Promise<void> {
  try {
    const now = Date.now();
    const raw = await env.ORDERS_KV.get(BEAT_KEY);
    if (raw !== null) {
      const last = Number(raw);
      if (Number.isFinite(last) && now - last < BEAT_INTERVAL_MS) return;
    }
    emit("info", "heartbeat", data);
    // В ring не пишем — буфер сбросится в конце тика, heartbeat виден в console.
    await env.ORDERS_KV.put(BEAT_KEY, String(now), { expirationTtl: BEAT_TTL });
  } catch (e) {
    console.error(`logger heartbeat failed: ${String(e)}`);
  }
}

export async function readRing(env: Env): Promise<unknown[]> {
  const raw = await env.ORDERS_KV.get(RING_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
