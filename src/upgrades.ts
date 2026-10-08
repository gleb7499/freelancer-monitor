import type { Env, UpgradeId } from "./types";

export interface UpgradePrice {
  id: UpgradeId;
  label: string;
  approx: boolean;
}

const PRICES: Record<
  UpgradeId,
  (bidAmount: number) => { label: string; approx: boolean }
> = {
  // Sealed: $0.10 стабильно (наблюдение Gleb'а). Покупка через API сейчас
  // требует PFP (USER_NOT_IN_PFP, проверено 05.10.2026) — веб-форма при этом
  // предлагает $0.10; покупка API-автоматом не гарантирована.
  sealed: () => ({ label: "sealed $0.10", approx: false }),
  // Sponsored: цена динамическая per project (скриншоты: $1.90 на ₹7000 и $2.90
  // на $500). Оценка 0.75% — только ориентир; реальная цена известна форме ставки.
  sponsored: (bid) => {
    const raw = bid * 0.0075;
    const clamped = Math.min(19.99, Math.max(1.9, raw));
    const price = Math.round(clamped * 100) / 100;
    return { label: `sponsored ~$${price.toFixed(2)}`, approx: true };
  },
};

// Дневной лимит покупок sponsored: дорого и заметно, больше 3 в сутки не тратим.
const SPONSORED_DAILY_LIMIT = 3;

// Суточный счётчик покупок sponsored в KV: `sponsor:daily:{yyyymmdd}` (Минск).
// TTL 2 суток — вчерашний ключ сам сгниёт, чистка не нужна.
function sponsoredDayKey(dateMs: number): string {
  const d = new Date(dateMs + 3 * 3600_000); // Europe/Minsk, UTC+3 без переходов
  const yyyymmdd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `sponsor:daily:${yyyymmdd}`;
}

// Сколько sponsored-покупок осталось сегодня. Ошибки KV не блокируют покупку
// (лимит — самодисциплина, а не защита от платформы): при сбое отвечаем лимитом.
export async function sponsoredDailyLeft(env: Env, dateMs = Date.now()): Promise<number> {
  try {
    const raw = await env.ORDERS_KV.get(sponsoredDayKey(dateMs));
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { count?: unknown };
      if (typeof parsed.count === "number" && Number.isFinite(parsed.count)) {
        return Math.max(0, SPONSORED_DAILY_LIMIT - parsed.count);
      }
    }
  } catch (e) {
    console.warn("sponsoredDailyLeft: KV read failed, assuming full limit", String(e));
  }
  return SPONSORED_DAILY_LIMIT;
}

// Зафиксировать покупку sponsored (+1 к сегодняшнему счётчику).
export async function spendSponsored(env: Env, dateMs = Date.now()): Promise<void> {
  try {
    const left = await sponsoredDailyLeft(env, dateMs);
    const count = SPONSORED_DAILY_LIMIT - left + 1;
    await env.ORDERS_KV.put(
      sponsoredDayKey(dateMs),
      JSON.stringify({ count }),
      { expirationTtl: 2 * 86400 },
    );
  } catch (e) {
    console.warn("spendSponsored: KV write failed", String(e));
  }
}

export function priceUpgrades(take: UpgradeId[], bidAmount: number): UpgradePrice[] {
  return take.map((id) => ({ id, ...PRICES[id](bidAmount) }));
}

export function totalPrice(prices: UpgradePrice[]): number {
  let sum = 0;
  for (const p of prices) {
    sum += extractAmount(p.label);
  }
  return Math.round(sum * 100) / 100;
}

function extractAmount(label: string): number {
  const m = label.match(/\$([\d.]+)/);
  return m ? Number(m[1]) : 0;
}

// Потолок суммы ВСЕХ апгрейдов заказа: 15% от суммы ставки (философия:
// допы — дешёвый рычаг, а не статья расходов; sealed $0.10 проходит почти
// всегда, вырезается в основном sponsored).
export function enforceUpgradeCap(
  take: UpgradeId[],
  bidAmount: number,
  netAmount: number,
): { kept: UpgradeId[]; removed: UpgradeId[] } {
  const kept = [...take];
  const removed: UpgradeId[] = [];
  const cap = bidAmount * 0.15;
  void netAmount; // оставлено в сигнатуре для совместимости вызовов

  const costOf = (ids: UpgradeId[]) =>
    totalPrice(priceUpgrades(ids, bidAmount));

  // Cut priority: sponsored only (sealed $0.10 kept almost always).
  const cutOrder: UpgradeId[] = ["sponsored"];
  let guard = 0;
  while (costOf(kept) > cap && guard++ < 10) {
    const victim = cutOrder.find((id) => kept.includes(id));
    if (!victim) break;
    kept.splice(kept.indexOf(victim), 1);
    removed.push(victim);
  }
  return { kept, removed };
}
