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
  return {
    weeklyLimitHours: num(env, "DEFAULT_WEEKLY_LIMIT", 40),
    kimiBase: stripTrailingSlash(env.KIMI_API_BASE ?? ""),
    kimiModel: env.KIMI_MODEL ?? "",
    freelancerBase: stripTrailingSlash(env.FREELANCER_API_BASE ?? ""),
    flUserId: (env.FL_USER_ID ?? "").trim(),
    flAuthHash: (env.FL_AUTH_HASH ?? "").trim(),
    flOauthToken: (env.FL_OAUTH_TOKEN ?? "").trim(),
    flApiKey: (env.FL_API_KEY ?? "").trim(),
    targetHourly: num(env, "TARGET_HOURLY", 20),
    bidMinScore: num(env, "BID_MIN_SCORE", 30),
    // Потолки фазы 0: конкуренция и бюджет (USD; для почасовых — ставка/ч).
    phaseMaxBids: num(env, "PHASE_MAX_BIDS", 10),
    phaseBudgetFixedUsd: num(env, "PHASE_BUDGET_FIXED_USD", 50),
    phaseBudgetHourlyUsd: num(env, "PHASE_BUDGET_HOURLY_USD", 10),
  };
}

export type Config = ReturnType<typeof getConfig>;
