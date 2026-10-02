import type { Env, Order, Niche } from "./types";

// Видимость заказов в D1 (было KV `seen:*` — free tier KV = 1000 put/сутки).
// Ретеншн 30 дней: daily-чистка по ts (флаг расписания живёт в KV, 1 put/сутки).
const SEEN_RETENTION_MS = 30 * 86400 * 1000;
const SEEN_CLEANUP_KEY = "seen:cleanup:last";
const SEEN_CLEANUP_INTERVAL_MS = 86400 * 1000;
// Лимит D1 — 100 переменных на запрос: SELECT-батч ≤100 id,
// INSERT-батч ≤20 строк × 5 полей.
const FILTER_BATCH = 100;
const INSERT_BATCH = 20;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function maybeCleanupSeen(env: Env): Promise<void> {
  try {
    const raw = await env.ORDERS_KV.get(SEEN_CLEANUP_KEY);
    const last = raw === null ? 0 : Number(raw);
    if (Number.isFinite(last) && Date.now() - last < SEEN_CLEANUP_INTERVAL_MS) {
      return;
    }
    await env.ORDERS_KV.put(SEEN_CLEANUP_KEY, String(Date.now()), {
      expirationTtl: 2 * 86400,
    });
    const cutoff = Date.now() - SEEN_RETENTION_MS;
    const result = await env.DB.prepare("DELETE FROM seen WHERE ts < ?").bind(cutoff).run();
    console.log("seen.cleanup", { deleted: result.meta.changes });
  } catch (e) {
    console.error("seen.cleanup failed:", e);
  }
}

async function findSeenIds(env: Env, ids: number[]): Promise<Set<number>> {
  const seen = new Set<number>();
  for (const batch of chunks(ids, FILTER_BATCH)) {
    const placeholders = batch.map(() => "?").join(", ");
    const rows = await env.DB.prepare(`SELECT id FROM seen WHERE id IN (${placeholders})`)
      .bind(...batch)
      .all<{ id: number }>();
    for (const row of rows.results ?? []) {
      seen.add(row.id);
    }
  }
  return seen;
}

export async function filterNew(env: Env, orders: Order[]): Promise<Order[]> {
  if (orders.length === 0) return [];
  await maybeCleanupSeen(env);
  const seenIds = await findSeenIds(
    env,
    orders.map((o) => o.id),
  );
  return orders.filter((o) => !seenIds.has(o.id));
}

export function classifyCompetition(bids: number): "normal" | "high" | null {
  if (bids < 0 || bids > 50) return null;
  if (bids <= 15) return "normal";
  return "high";
}

export function staticReject(order: Order): string | null {
  if (order.bids > 50) return `rej:bids>50`;
  if (order.upgrades.fulltime) return "rej:fulltime";
  if (order.language !== "en") return `rej:lang=${order.language}`;
  if (order.deadline_hint !== null && order.submit_ts > 0) {
    const m = /bidperiod (\d+)d/.exec(order.deadline_hint);
    if (m !== null) {
      const bidperiodDays = Number(m[1]);
      const nowSec = Math.floor(Date.now() / 1000);
      if (order.submit_ts + bidperiodDays * 86400 < nowSec) return "rej:expired";
    }
  }
  return null;
}

interface SeenRecord {
  id: number;
  source: string;
  status: string;
  reason: string | null;
  ts: number;
}

async function insertSeen(env: Env, records: SeenRecord[]): Promise<void> {
  for (const batch of chunks(records, INSERT_BATCH)) {
    const values = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((r) => [r.id, r.source, r.status, r.reason, r.ts]);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO seen (id, source, status, reason, ts) VALUES ${values}`
    ).bind(...params).run();
  }
}

// Alert-заказы Freelancer уже отфильтровал по сохранённому поиску —
// без staticReject и без competition-отсева. Единственный жёсткий фильтр —
// bids > 50 (правило общее для обоих каналов). Возвращает заказы,
// прошедшие этот фильтр; все увиденные помечаются в seen.
export async function markAlertSeen(env: Env, orders: Order[]): Promise<Order[]> {
  if (orders.length === 0) return [];
  const kept = orders.filter((o) => o.bids <= 50);
  const records = orders.map((o) => ({
    id: o.id,
    source: "alert",
    status: o.bids > 50 ? "rejected" : "passed",
    reason: o.bids > 50 ? "rej:bids>50" : null,
    ts: Date.now(),
  }));
  await insertSeen(env, records);
  return kept;
}

export async function processOrders(
  env: Env,
  orders: Order[]
): Promise<{
  fresh: Order[];
  rejectedCount: number;
  seenCount: number;
  byReason: Record<string, number>;
}> {
  const fresh = await filterNew(env, orders);
  const seenCount = orders.length - fresh.length;

  let rejectedCount = 0;
  const freshOrders: Order[] = [];
  const byReason: Record<string, number> = {};
  const records: SeenRecord[] = [];

  for (const order of fresh) {
    const tier = classifyCompetition(order.bids);
    if (tier === null) {
      const reason = "rej:bids>50";
      rejectedCount += 1;
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      records.push({ id: order.id, source: order.source ?? "search", status: "rejected", reason, ts: Date.now() });
      continue;
    }
    order.competition = tier;
    const reason = staticReject(order);
    records.push({
      id: order.id,
      source: order.source ?? "search",
      status: reason ? "rejected" : "passed",
      reason,
      ts: Date.now(),
    });
    if (reason) {
      rejectedCount += 1;
      const key = reason.split("=")[0];
      byReason[key] = (byReason[key] ?? 0) + 1;
    } else {
      freshOrders.push(order);
    }
  }

  await insertSeen(env, records);

  return { fresh: freshOrders, rejectedCount, seenCount, byReason };
}

// Ротация считается от времени, без KV: 12 ниш × 4 за тик = полный проход
// за 3 минуты, курсор = (минута_эпохи × perTick) % len. Пропуск тика сдвигает
// окно, но не ломает покрытие. KV-вариант съедал ~2880 put/get в сутки
// (free tier KV — 1000 put/сутки).
export function pickNiches(all: Niche[], perTick: number): Niche[] {
  if (all.length === 0 || perTick >= all.length) return all;

  const minute = Math.floor(Date.now() / 60000);
  const cursor = (minute * perTick) % all.length;

  const picked: Niche[] = [];
  for (let i = 0; i < perTick; i += 1) {
    picked.push(all[(cursor + i) % all.length]);
  }
  return picked;
}
