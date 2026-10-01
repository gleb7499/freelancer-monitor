import type { Env, Order, Niche } from "./types";

const SEEN_TTL = 2592000;
const ROTATION_KEY = "rot:cursor";

interface SeenRecord {
  status: string;
  reason?: string;
  ts: number;
}

function seenKey(id: number): string {
  return `seen:${id}`;
}

export async function filterNew(env: Env, orders: Order[]): Promise<Order[]> {
  const results = await Promise.all(
    orders.map(async (order) => {
      const existing = await env.ORDERS_KV.get(seenKey(order.id));
      return existing === null ? order : null;
    })
  );
  return results.filter((o): o is Order => o !== null);
}

export function classifyCompetition(bids: number): "normal" | "high" | "extreme" | null {
  if (bids < 0 || bids > 100) return null;
  if (bids <= 15) return "normal";
  if (bids <= 50) return "high";
  return "extreme";
}

export function staticReject(order: Order): string | null {
  if (order.bids > 100) return `rej:bids>100`;
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

  await Promise.all(
    fresh.map(async (order) => {
      const tier = classifyCompetition(order.bids);
      if (tier === null) {
        const reason = "rej:bids>100";
        rejectedCount += 1;
        byReason[reason] = (byReason[reason] ?? 0) + 1;
        await env.ORDERS_KV.put(seenKey(order.id), JSON.stringify({ status: "rejected", reason, ts: Date.now() }), {
          expirationTtl: SEEN_TTL,
        });
        return;
      }
      order.competition = tier;
      const reason = staticReject(order);
      const record: SeenRecord = reason
        ? { status: "rejected", reason, ts: Date.now() }
        : { status: "passed", ts: Date.now() };
      await env.ORDERS_KV.put(seenKey(order.id), JSON.stringify(record), {
        expirationTtl: SEEN_TTL,
      });
      if (reason) {
        rejectedCount += 1;
        const key = reason.split("=")[0];
        byReason[key] = (byReason[key] ?? 0) + 1;
      } else {
        freshOrders.push(order);
      }
    })
  );

  return { fresh: freshOrders, rejectedCount, seenCount, byReason };
}

export async function pickNiches(env: Env, all: Niche[], perTick: number): Promise<Niche[]> {
  if (all.length === 0 || perTick >= all.length) return all;

  const raw = await env.ORDERS_KV.get(ROTATION_KEY);
  let cursor = 0;
  if (raw !== null) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) cursor = ((parsed % all.length) + all.length) % all.length;
  }

  const picked: Niche[] = [];
  for (let i = 0; i < perTick; i += 1) {
    picked.push(all[(cursor + i) % all.length]);
  }

  const next = (cursor + perTick) % all.length;
  await env.ORDERS_KV.put(ROTATION_KEY, String(next), { expirationTtl: SEEN_TTL });
  return picked;
}

export async function markStatus(
  env: Env,
  id: number,
  status: string,
  reason?: string
): Promise<void> {
  const key = seenKey(id);
  const existing = await env.ORDERS_KV.get(key);
  const record: SeenRecord = { status, ts: Date.now() };
  if (reason !== undefined) {
    record.reason = reason;
  } else if (existing !== null) {
    try {
      const prev = JSON.parse(existing) as SeenRecord;
      if (prev.reason !== undefined) record.reason = prev.reason;
    } catch {
      // ignore malformed record
    }
  }
  await env.ORDERS_KV.put(key, JSON.stringify(record), { expirationTtl: SEEN_TTL });
}
