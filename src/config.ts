import type { Env } from "./types";

function num(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  if (typeof raw !== "string" || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getConfig(env: Env) {
  const minBudgetFallback = num(env, "MIN_BUDGET_USD", 50);
  return {
    maxBids: num(env, "MAX_BIDS", 15),
    minBudgetUsd: minBudgetFallback,
    minFixedUsd: num(env, "MIN_FIXED_USD", minBudgetFallback),
    minHourlyUsd: num(env, "MIN_HOURLY_USD", 15),
    weeklyLimitHours: num(env, "DEFAULT_WEEKLY_LIMIT", 40),
    maxCardsPerHour: num(env, "MAX_CARDS_PER_HOUR", 5),
    nichesPerTick: num(env, "NICHES_PER_TICK", 4),
    kimiBase: stripTrailingSlash(env.KIMI_API_BASE ?? ""),
    kimiModel: env.KIMI_MODEL ?? "",
    freelancerBase: stripTrailingSlash(env.FREELANCER_API_BASE ?? ""),
  };
}

export type Config = ReturnType<typeof getConfig>;
