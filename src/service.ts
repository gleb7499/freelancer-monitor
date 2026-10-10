import type { Env, Order } from "./types";
import type { Config } from "./config";
import { getConfig } from "./config";
import { CRYPTO_SKILL_ID } from "./enrich";

// Видимость заказов в D1 (было KV `seen:*` — free tier KV = 1000 put/сутки).
// Ретеншн 30 дней: daily-чистка по ts (флаг расписания живёт в KV, 1 put/сутки).
const SEEN_RETENTION_MS = 30 * 86400 * 1000;
const SEEN_CLEANUP_KEY = "seen:cleanup:last";
const SEEN_CLEANUP_INTERVAL_MS = 86400 * 1000;
// Лимит D1 — 100 переменных на запрос: SELECT-батч ≤100 id,
// INSERT-батч ≤20 строк × 5 полей.
const FILTER_BATCH = 100;
const INSERT_BATCH = 20;

// Единственный жёсткий статический фильтр алерт-канала был конкуренция
// (bids > 10) — снят 08.10.2026: конкуренция теперь фактор скоринга, не вето.
// Остаётся мягкий пре-гейт физической возможности ставки (ниже).

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

// Мягкий пре-гейт до LLM: физическая невозможность ставки, которую нельзя
// было определить из выдачи intake (она не отдаёт скиллы и часть флагов).
// Детектируется после enrich (fetchProjectClient): recruiter/KYC-флаги —
// из заказа, крипто-скилл — из ответа projects/seo.
// Возвращает reason вида `rej:...` или null (заказ можно скорить).

// Жёсткие гейты фазы 0 (первые отзывы): конкуренция и бюджет отсекаются кодом
// до LLM. Пороги — из конфигурации (cfg.phaseMaxBids и т.д.).
// Жёсткая конкуренция на входе: заказ берётся секунд после публикации, так что
// >N откликов уже в момент появления = аукцион бешеный и растёт, шанс попасть
// в топ выдачи клиента низкий — отклоняем кодом, не тратя LLM. Число откликов
// нигде больше не используется: LLM его не видит (см. buildScoringUserMessage).
// budget_min — USD-поля (парсер пересчитывает в USD; для почасовых это ставка/ч);
// дно неизвестно (=0) — заказ пропускаем гейт.

export function preBidRejectReason(order: Order, cfg: Config): string | null {
  if (order.upgrades.recruiter) return "rej:recruiter";
  if (order.is_seller_kyc_required) return "rej:kyc-required";
  if (order.client?.skill_ids?.includes(CRYPTO_SKILL_ID)) return "rej:crypto-verified";
  if (order.bids > cfg.phaseMaxBids) return "rej:hot-competition";
  if (order.type === "fixed" && order.budget_min > cfg.phaseBudgetFixedUsd) {
    return "rej:budget-fixed";
  }
  if (order.type === "hourly" && order.budget_min > cfg.phaseBudgetHourlyUsd) {
    return "rej:budget-hourly";
  }
  return null;
}

// Заказы с источника (официальный API) — фильтр до LLM: мягкий пре-гейт
// физической возможности ставки (preBidRejectReason, требует заполненного
// order.client — enrich идёт ДО вызова) плюс жёсткие гейты фазы 0
// (конкуренция и бюджет — пороги из getConfig).
// Все увиденные помечаются в seen (source из параметра), отказники — rejected.
export async function markAlertSeen(
  env: Env,
  orders: Order[],
  source = "active",
): Promise<{ kept: Order[]; rejected: { order: Order; reason: string }[] }> {
  if (orders.length === 0) return { kept: [], rejected: [] };
  const cfg = getConfig(env);
  const reasons = new Map<number, string>();
  for (const o of orders) {
    const r = preBidRejectReason(o, cfg);
    if (r !== null) reasons.set(o.id, r);
  }
  const records = orders.map((o) => ({
    id: o.id,
    source,
    status: reasons.has(o.id) ? "rejected" : "passed",
    reason: reasons.get(o.id) ?? null,
    ts: Date.now(),
  }));
  await insertSeen(env, records);
  return {
    kept: orders.filter((o) => !reasons.has(o.id)),
    rejected: orders
      .filter((o) => reasons.has(o.id))
      .map((o) => ({ order: o, reason: reasons.get(o.id)! })),
  };
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
