import type { Env } from "./types";
import { resolveWebAuth, webAuthHeaders } from "./web-auth";

// Баланс bids. Основной источник — read-only endpoint сайта
// ajax-api/projects/getBidLimit.php (та же веб-авторизация freelancer-auth-v2,
// что у alerts-канала): отдаёт bidsRemaining, bidLimit и bidRefreshTime
// (секунды до следующего реген-бида). Официальный API баланс не отдаёт
// (проверено: users/0.1/self и SDK). Fallback — леджер на D1
// (миграция 0002_bid_ledger.sql): balance = lastKnown + реген 1/7.5ч,
// кап = bidLimit, сохранённый последним удачным ответом API (KV bids:limit;
// 100 — только пока лимит ни разу не прочитан: подписка может поднять потолок).
//
// Частота обращений: endpoint скрытый, опрашивать его тиками нельзя — читатели
// ходят через BidBudget (durable.ts), который обновляет значение по событиям
// (ставка, будильник регенерации, сторожевой раз в час). getBidsBalance здесь —
// рабочая лошадка BidBudget.refresh, а не путь для тиков каналов.

const DEFAULT_BID_LIMIT = 100;
const REGEN_MS = 7.5 * 60 * 60 * 1000;
const BID_LIMIT_URL =
  "https://www.freelancer.com/ajax-api/projects/getBidLimit.php";
const FETCH_TIMEOUT_MS = 10000;
const KV_BID_LIMIT = "bids:limit";

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
  // Сырые поля ответа API (у леджер-фолбэка — null/false).
  bidRefreshSec: number | null;
  bidLimit: number | null;
  unlimited: boolean;
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
  const auth = await resolveWebAuth(env);
  if (auth === null) return null;
  try {
    const res = await fetch(`${BID_LIMIT_URL}?userId=${auth.userId}&compact=true`, {
      headers: webAuthHeaders(auth),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BidLimitResponse;
    const r = data.result;
    if (data.status !== "success" || !r || typeof r.bidsRemaining !== "number") {
      return null;
    }
    const unlimited = r.unlimitedBids === true;
    const bidRefreshSec =
      typeof r.bidRefreshTime === "number" && r.bidRefreshTime > 0 ? r.bidRefreshTime : null;
    if (typeof r.bidLimit === "number" && r.bidLimit > 0) {
      await env.ORDERS_KV.put(KV_BID_LIMIT, String(r.bidLimit));
    }
    return {
      balance: r.bidsRemaining,
      nextBidInMinutes:
        !unlimited && bidRefreshSec !== null ? Math.max(1, Math.round(bidRefreshSec / 60)) : null,
      source: "api",
      bidRefreshSec,
      bidLimit: typeof r.bidLimit === "number" ? r.bidLimit : null,
      unlimited,
    };
  } catch (e) {
    console.warn("getBidLimit fetch failed:", e);
    return null;
  }
}

// Кап регенерации: последний известный лимит из API, иначе 100.
async function bidLimitCap(env: Env): Promise<number> {
  const raw = await env.ORDERS_KV.get(KV_BID_LIMIT);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BID_LIMIT;
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
  const cap = await bidLimitCap(env);
  const regenerated = Math.floor((Date.now() - last.ts) / REGEN_MS);
  return Math.min(cap, last.delta + regenerated);
}

export async function getBidsBalance(env: Env): Promise<BidsBalance> {
  const api = await fetchBidLimitApi(env);
  if (api !== null) return api;

  const cap = await bidLimitCap(env);
  const balance = await reconcile(env);
  const ledger: Omit<BidsBalance, "balance" | "nextBidInMinutes"> = {
    source: "ledger",
    bidRefreshSec: null,
    bidLimit: cap,
    unlimited: false,
  };
  if (balance === null) {
    return { ...ledger, balance: null, nextBidInMinutes: null, bidLimit: null };
  }
  // nextBidInMinutes: при полном балансе реген не нужен.
  if (balance >= cap) {
    return { ...ledger, balance, nextBidInMinutes: null };
  }
  const last = (await lastRow(env))!;
  const sinceLast = Date.now() - last.ts;
  const msToNext = REGEN_MS - (sinceLast % REGEN_MS);
  return {
    ...ledger,
    balance,
    nextBidInMinutes: Math.max(1, Math.round(msToNext / 60000)),
  };
}

// Списать 1 ставку после успешного размещения.
export async function recordBidSpent(env: Env, note: string): Promise<void> {
  const balance = await reconcile(env);
  await env.DB.prepare("INSERT INTO bid_ledger (ts, delta, note) VALUES (?, ?, ?)")
    .bind(Date.now(), (balance ?? 0) - 1, note)
    .run();
}
