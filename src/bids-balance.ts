import type { Env } from "./types";
import { resolveAuth } from "./sources/freelancer-alerts";

// Баланс bids. Основной источник — read-only endpoint сайта
// ajax-api/projects/getBidLimit.php (та же веб-авторизация freelancer-auth-v2,
// что у alerts-канала): отдаёт bidsRemaining, bidLimit и bidRefreshTime
// (секунды до следующего реген-бида). Официальный API баланс не отдаёт
// (проверено: users/0.1/self и SDK). Fallback — леджер на D1
// (миграция 0002_bid_ledger.sql): balance = lastKnown + реген 1/7.5ч, кап 100.

const MAX_BIDS = 100;
const REGEN_MS = 7.5 * 60 * 60 * 1000;
const BID_LIMIT_URL =
  "https://www.freelancer.com/ajax-api/projects/getBidLimit.php";
const FETCH_TIMEOUT_MS = 10000;

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

interface BidLimitResponse {
  status?: string;
  result?: {
    bidsRemaining?: number;
    bidLimit?: number;
    bidRefreshTime?: number;
    unlimitedBids?: boolean;
  };
}

async function fetchBidLimitApi(env: Env): Promise<BidsBalance | null> {
  const auth = await resolveAuth(env);
  if (auth === null) return null;
  try {
    const res = await fetch(`${BID_LIMIT_URL}?userId=${auth.userId}&compact=true`, {
      headers: {
        accept: "application/json",
        "freelancer-app-name": "main",
        "freelancer-app-platform": "web",
        "freelancer-auth-v2": `${auth.userId};${auth.hash}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BidLimitResponse;
    const r = data.result;
    if (data.status !== "success" || !r || typeof r.bidsRemaining !== "number") {
      return null;
    }
    return {
      balance: r.bidsRemaining,
      nextBidInMinutes:
        typeof r.bidRefreshTime === "number" && r.bidRefreshTime > 0
          ? Math.max(1, Math.round(r.bidRefreshTime / 60))
          : null,
      source: "api",
    };
  } catch (e) {
    console.warn("getBidLimit fetch failed:", e);
    return null;
  }
}

async function lastRow(env: Env): Promise<LedgerRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, ts, delta, note FROM bid_ledger ORDER BY id DESC LIMIT 1"
  ).first<LedgerRow>();
  return row ?? null;
}

// Восстановить баланс из последней известной точки леджера.
// Леджер пуст → null.
async function reconcile(env: Env): Promise<number | null> {
  const last = await lastRow(env);
  if (!last) return null;
  const regenerated = Math.floor((Date.now() - last.ts) / REGEN_MS);
  return Math.min(MAX_BIDS, last.delta + regenerated);
}

export async function getBidsBalance(env: Env): Promise<BidsBalance> {
  const api = await fetchBidLimitApi(env);
  if (api !== null) return api;

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

// Списать 1 ставку после успешного размещения.
export async function recordBidSpent(env: Env, note: string): Promise<void> {
  const balance = await reconcile(env);
  await env.DB.prepare("INSERT INTO bid_ledger (ts, delta, note) VALUES (?, ?, ?)")
    .bind(Date.now(), (balance ?? 0) - 1, note)
    .run();
}
