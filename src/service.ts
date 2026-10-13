import type { Env, Order } from "./types";
import type { Config } from "./config";
import { CRYPTO_SKILL_ID } from "./enrich";

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
