import type { Env } from "./types";

// Леджер ставок на D1 (таблица bid_ledger, миграция 0002_bid_ledger.sql).
// Официальный API баланса bids требует OAuth (без токена — 401), поэтому
// баланс восстанавливаем леджером:
//   balance = lastKnown + floor((now - lastTs) / REGEN_MS) - spent, кап MAX_BIDS.
// Модель ресурса: Plus-тариф — 100 bids/мес, реген 1 bid / 7.5 ч.
// До первой команды setBalance баланс «неизвестен» (balance = null) —
// скоринг работает без поднятия планки.

const MAX_BIDS = 100;
const REGEN_MS = 7.5 * 60 * 60 * 1000;

interface LedgerRow {
  id: number;
  ts: number;
  delta: number;
  note: string | null;
}

export interface BidsBalance {
  balance: number | null;
  nextBidInMinutes: number | null;
  source: "api" | "ledger";
}

async function lastRow(env: Env): Promise<LedgerRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, ts, delta, note FROM bid_ledger ORDER BY id DESC LIMIT 1"
  ).first<LedgerRow>();
  return row ?? null;
}

// Восстановить баланс из последней известной точки леджера.
// Леджер пуст (setBalance ни разу не вызывали) → null.
async function reconcile(env: Env): Promise<number | null> {
  const last = await lastRow(env);
  if (!last) return null;
  const regenerated = Math.floor((Date.now() - last.ts) / REGEN_MS);
  return Math.min(MAX_BIDS, last.delta + regenerated);
}

export async function getBidsBalance(env: Env): Promise<BidsBalance> {
  const balance = await reconcile(env);
  if (balance === null) {
    return { balance: null, nextBidInMinutes: null, source: "ledger" };
  }
  // nextBidInMinutes: при полном балансе реген не нужен.
  if (balance >= MAX_BIDS) {
    return { balance, nextBidInMinutes: null, source: "ledger" };
  }
  const last = (await lastRow(env))!;
  const sinceLast = Date.now() - last.ts;
  const msToNext = REGEN_MS - (sinceLast % REGEN_MS);
  return {
    balance,
    nextBidInMinutes: Math.max(1, Math.round(msToNext / 60000)),
    source: "ledger",
  };
}

// Команда оператора /setbids N — зафиксировать фактический баланс.
export async function setBalance(env: Env, n: number): Promise<void> {
  const clamped = Math.max(0, Math.min(MAX_BIDS, Math.floor(n)));
  await env.DB.prepare(
    "INSERT INTO bid_ledger (ts, delta, note) VALUES (?, ?, ?)"
  )
    .bind(Date.now(), clamped, `setbids:${clamped}`)
    .run();
}

// Списать 1 ставку после успешного размещения.
export async function recordBidSpent(env: Env, note: string): Promise<void> {
  const balance = await reconcile(env);
  await env.DB.prepare("INSERT INTO bid_ledger (ts, delta, note) VALUES (?, ?, ?)")
    .bind(Date.now(), (balance ?? 0) - 1, note)
    .run();
}
