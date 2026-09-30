import type { UpgradeId } from "./types";

export interface UpgradePrice {
  id: UpgradeId;
  label: string;
  approx: boolean;
}

const PRICES: Record<
  UpgradeId,
  (bidAmount: number) => { label: string; approx: boolean }
> = {
  sealed: () => ({ label: "sealed $0.10", approx: false }),
  sponsored: (bid) => {
    const raw = bid * 0.0075;
    const clamped = Math.min(19.99, Math.max(1.9, raw));
    const price = Math.round(clamped * 100) / 100;
    return { label: `sponsored $${price.toFixed(2)}`, approx: false };
  },
  highlight: () => ({ label: "highlight ~$0.75", approx: true }),
};

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

export function enforceUpgradeCap(
  take: UpgradeId[],
  bidAmount: number,
  netAmount: number,
): { kept: UpgradeId[]; removed: UpgradeId[] } {
  const kept = [...take];
  const removed: UpgradeId[] = [];
  const cap = Math.min(netAmount * 0.03, 3);

  const costOf = (ids: UpgradeId[]) =>
    totalPrice(priceUpgrades(ids, bidAmount));

  // Cut priority: sponsored first, then highlight; sealed ($0.10) kept almost always.
  const cutOrder: UpgradeId[] = ["sponsored", "highlight"];
  let guard = 0;
  while (costOf(kept) > cap && guard++ < 10) {
    const victim = cutOrder.find((id) => kept.includes(id));
    if (!victim) break;
    kept.splice(kept.indexOf(victim), 1);
    removed.push(victim);
  }
  return { kept, removed };
}
