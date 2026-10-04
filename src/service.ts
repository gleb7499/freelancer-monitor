import type { Env, Order } from "./types";

// Видимость заказов в D1 (было KV `seen:*` — free tier KV = 1000 put/сутки).
// Ретеншн 30 дней: daily-чистка по ts (флаг расписания живёт в KV, 1 put/сутки).
const SEEN_RETENTION_MS = 30 * 86400 * 1000;
const SEEN_CLEANUP_KEY = "seen:cleanup:last";
const SEEN_CLEANUP_INTERVAL_MS = 86400 * 1000;
// Лимит D1 — 100 переменных на запрос: SELECT-батч ≤100 id,
// INSERT-батч ≤20 строк × 5 полей.
const FILTER_BATCH = 100;
const INSERT_BATCH = 20;

// Единственный жёсткий статический фильтр алерт-канала: конкуренция.
// Бюджет/ставка НЕ фильтруются — ценовая пригодность решает только LLM.
const MAX_BIDS_GATE = 10;

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

// Заказы с источника (официальный API) — единственный жёсткий фильтр:
// bids > 10. Все увиденные помечаются в seen (source из параметра);
// bids>10 идут со status rejected reason `rej:bids>10`.
// Возвращает заказы, прошедшие гейт.
export async function markAlertSeen(env: Env, orders: Order[], source = "active"): Promise<Order[]> {
  if (orders.length === 0) return [];
  const kept = orders.filter((o) => o.bids <= MAX_BIDS_GATE);
  const records = orders.map((o) => ({
    id: o.id,
    source,
    status: o.bids > MAX_BIDS_GATE ? "rejected" : "passed",
    reason: o.bids > MAX_BIDS_GATE ? "rej:bids>10" : null,
    ts: Date.now(),
  }));
  await insertSeen(env, records);
  return kept;
}

// Пометить заказы отклонёнными по внешнему условию (например, bids-баланс = 0).
// Без пометки заказы зависли бы и перескорились никогда.
export async function markRejected(env: Env, orders: Order[], reason: string): Promise<void> {
  if (orders.length === 0) return;
  const records = orders.map((o) => ({
    id: o.id,
    source: o.source ?? "active",
    status: "rejected",
    reason,
    ts: Date.now(),
  }));
  await insertSeen(env, records);
}

// Статистика seen за последние 24 часа — для команды /status.
export async function seenStats24h(
  env: Env,
): Promise<{ status: string; source: string; count: number }[]> {
  const since = Date.now() - 24 * 3600 * 1000;
  const rows = await env.DB.prepare(
    "SELECT status, source, COUNT(*) AS count FROM seen WHERE ts > ? GROUP BY status, source",
  )
    .bind(since)
    .all<{ status: string; source: string; count: number }>();
  return rows.results ?? [];
}
