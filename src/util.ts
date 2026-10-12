import type { Order } from "./types";

// Компаратор сортировки заказов к скорингу: при дефиците bids свежие заказы
// релевантнее — размещение идёт по этому порядку, LLM-квота тратится на всех.
export function bySubmitTsDesc(a: Order, b: Order): number {
  return b.submit_ts - a.submit_ts;
}

// Пул параллелизма: не более `limit` одновременных выполнений функций из
// очереди. Ошибки вызывающего кода изолируются вызывающим (try/catch внутри fn).
export async function runWithConcurrency<R>(
  fns: Array<() => Promise<R>>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(fns.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, fns.length) }, async () => {
    while (next < fns.length) {
      const i = next;
      next += 1;
      results[i] = await fns[i]();
    }
  });
  await Promise.all(workers);
  return results;
}
