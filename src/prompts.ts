import type { Order, Env } from "./types";
import { RULES_FREELANCER_SELECTION, RULES_BID_SKILL, RULES_HUMANIZE } from "./generated/rules";
import scoringSystemMd from "../prompts/scoring-system.md";
import scoringUserMd from "../prompts/scoring-user.md";
import scoringGateOnMd from "../prompts/scoring-gate-on.md";
import scoringGateOffMd from "../prompts/scoring-gate-off.md";
import scoringRetryMd from "../prompts/scoring-retry.md";
import bidTextSystemMd from "../prompts/bid-text-system.md";
import bidUserMd from "../prompts/bid-user.md";
import bidUserWeeklyMd from "../prompts/bid-user-weekly.md";
import bidUserPortfolioMd from "../prompts/bid-user-portfolio.md";
import bidUserMilestonesMd from "../prompts/bid-user-milestones.md";
import bidUserPriceMd from "../prompts/bid-user-price.md";
import humanizeSystemMd from "../prompts/humanize-system.md";
import humanizeLimitMd from "../prompts/humanize-limit.md";
import channelMainMd from "../prompts/channel-main.md";
import channelAndroidMd from "../prompts/channel-android.md";
import type { ProfileId } from "./channels";
import { ENABLED_PROFILES } from "./channels";

export interface ScoringPromptOptions {
  weeklyLimitHours: number;
  targetHourly: number;
  bidMinScore: number;
  scoreGateEnabled: boolean;
  phaseMaxBids: number;
  phaseBudgetFixedUsd: number;
  phaseBudgetHourlyUsd: number;
}

export interface ScoringContext {
  bidsBalance: number | null;
  nextBidInMinutes: number | null;
}

// Правило проекта: промтовый текст не хранится inline — только в prompts/*.md.
// Код подставляет токены {{TOKEN}} и отдаёт готовый промт. JSON-схемы ответа —
// машинный контракт, живут здесь же в коде.

// Текстовые файлы принято заканчивать переводом строки — отрезаем один,
// чтобы промт был байт-в-байт прежним (inline-шаблоны его не имели).
function text(md: string): string {
  return md.endsWith("\n") ? md.slice(0, -1) : md;
}

// Замена токенов {{TOKEN}} значениями; неизвестный токен оставляем как есть —
// лучше заметить опечатку в логах, чем промолчать пустую строку.
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (raw, key: string) => vars[key] ?? raw);
}

export function buildScoringSystemPrompt(
  opts: ScoringPromptOptions,
  profilesBlock: string,
): string {
  return fill(text(scoringSystemMd), {
    RULES_FREELANCER_SELECTION,
    PROFILES_BLOCK: profilesBlock,
    SCORE_GATE_RULES: fill(text(opts.scoreGateEnabled ? scoringGateOnMd : scoringGateOffMd), {
      BID_MIN_SCORE: String(opts.bidMinScore),
    }),
    TARGET_HOURLY: String(opts.targetHourly),
    WEEKLY_LIMIT_HOURS: String(opts.weeklyLimitHours),
    PHASE_MAX_BIDS: String(opts.phaseMaxBids),
    PHASE_BUDGET_FIXED_USD: String(opts.phaseBudgetFixedUsd),
    PHASE_BUDGET_HOURLY_USD: String(opts.phaseBudgetHourlyUsd),
  });
}

// Блок профилей для скоринга: только включённые каналы (kind "search").
// Содержит инструкцию выбора профиля по полю channel заказа.
export function buildProfilesBlock(env: Pick<Env, "CHANNEL_ANDROID_ENABLED">): string {
  const lines: string[] = [];
  for (const ch of ENABLED_PROFILES(env)) {
    lines.push(`Profile "${ch.id}" (${ch.label}):`);
    lines.push(text(ch.id === "main" ? channelMainMd : channelAndroidMd));
  }
  lines.push(
    'The order JSON has "source" and "channel". If "channel" is set (order from a dedicated search channel) — the profile is decided by code, still fill "profile" with your best guess (code overrides). If "channel" is null/absent (shared feed) — choose the best-fitting profile for this order and put its id in "profile". Choose ONLY among the profiles listed above.',
  );
  return lines.join("\n");
}

export function channelProfileMd(profile: ProfileId): string {
  return text(profile === "main" ? channelMainMd : channelAndroidMd);
}

// Полный текст профиля для NOTES пользовательского сообщения генератора текста.
export function buildChannelNote(profile: ProfileId): string {
  return channelProfileMd(profile);
}

// Первая строка файла профиля — "STACK: ...".
export function PROFILE_STACK(profile: ProfileId): string {
  return channelProfileMd(profile).split("\n", 1)[0];
}

export function buildScoringUserMessage(order: Order, ctx?: ScoringContext): string {
  const head = fill(text(scoringUserMd), {
    BIDS_BALANCE: ctx && ctx.bidsBalance !== null ? String(ctx.bidsBalance) : "unknown",
    NEXT_BID_MINUTES:
      ctx && ctx.nextBidInMinutes !== null ? String(ctx.nextBidInMinutes) : "unknown",
  });
  // Число откликов LLM не передаём: конкуренцию решает кодовый гейт на входе
  // (>50 при появлении → rej:hot-competition), текущий счётчик секунд после
  // публикации — шум. bid_avg уходит вместе с ним (цена ставки считает код).
  const { bids: _bids, bid_avg: _bidAvg, ...llmOrder } = order;
  return head + " " + JSON.stringify(llmOrder);
}

// Ретрай после неудавшейся валидации JSON скоринга: ошибки и подсказка
// по диапазону ставки собираются кодом, текст — в файле.
export function buildScoringRetryMessage(errors: string[], bidHint: string): string {
  return fill(text(scoringRetryMd), { ERRORS: errors.join("; "), BID_HINT: bidHint });
}

export function buildBidTextSystemPrompt(profile: ProfileId): string {
  return fill(text(bidTextSystemMd), {
    RULES_BID_SKILL,
    PROFILE_STACK: PROFILE_STACK(profile),
  });
}

export const BID_TEXT_MAX_CHARS = 1500;

// Второй проход редактуры: humanize-промт из rules/humanize.md (приоритетные
// правила проекта в его конце). Ошибка этого вызова не фатальна — берём черновик.
export const HUMANIZE_SYSTEM_PROMPT = fill(text(humanizeSystemMd), { RULES_HUMANIZE });

// Целевой диапазон длины отклика по размеру описания заказа (знаков).
export function bidTargetRange(descLen: number): { min: number; max: number } {
  if (descLen < 400) return { min: 600, max: 900 };
  if (descLen < 1200) return { min: 900, max: 1200 };
  return { min: 1200, max: 1400 };
}

export function buildHumanizeLimitMessage(
  charCount: number,
  maxChars: number,
  targetMax: number = 1400,
): string {
  return fill(text(humanizeLimitMd), {
    CHAR_COUNT: String(charCount),
    MAX_CHARS: String(maxChars),
    TARGET_MAX: String(targetMax),
  });
}

// Примечания пользовательского сообщения генератора текста ставки. Каждое
// возвращается только когда применимо (условия — в вызывающем коде).
export function buildBidWeeklyNote(weeklyLimitHours: number): string {
  return fill(text(bidUserWeeklyMd), { WEEKLY_LIMIT_HOURS: String(weeklyLimitHours) });
}

export function buildBidPortfolioNote(portfolioLines: string): string {
  return fill(text(bidUserPortfolioMd), { PORTFOLIO_LINES: portfolioLines });
}

export function buildBidMilestonesNote(): string {
  return text(bidUserMilestonesMd);
}

export function buildBidPriceNote(bidAmount: number, currency: string): string {
  return fill(text(bidUserPriceMd), {
    BID_AMOUNT: String(bidAmount),
    CURRENCY: currency,
  });
}

// Обёртка пользовательского сообщения генератора текста ставки.
export function buildBidUserMessage(
  orderJson: string,
  scoreJson: string,
  notes: string,
  descLen: number = 0,
): string {
  const { min, max } = bidTargetRange(descLen);
  return fill(text(bidUserMd), {
    ORDER_JSON: orderJson,
    SCORE_JSON: scoreJson,
    NOTES: notes,
    TARGET_MIN: String(min),
    TARGET_MAX: String(max),
    DESC_LEN: String(descLen),
  });
}

export const SCORING_JSON_SCHEMA = {
  name: "order_score",
  strict: true,
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["BID", "PASS"] },
      profile: { type: "string", enum: ["main", "android"] },
      reason: { type: "string" },
      summary_ru: { type: "string" },
      hours: {
        type: "object",
        properties: {
          opt: { type: "number" },
          real: { type: "number" },
          pess: { type: "number" },
        },
        required: ["opt", "real", "pess"],
        additionalProperties: false,
      },
      red_flags: { type: "array", items: { type: "string" } },
      check_manually: { type: "array", items: { type: "string" } },
      bid_amount: { type: "number" },
      net_amount: { type: "number" },
      value_score: { type: "number" },
      ai_hours: { type: "number" },
      weekly_limit_hours: { type: ["integer", "null"] },
      delivery_days: { type: "number" },
      deadline_caveat: { type: ["string", "null"] },
      milestones: {
        type: ["array", "null"],
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            share: { type: "integer" },
          },
          required: ["description", "share"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "verdict",
      "profile",
      "reason",
      "summary_ru",
      "hours",
      "red_flags",
      "check_manually",
      "bid_amount",
      "net_amount",
      "value_score",
      "ai_hours",
      "delivery_days",
      "deadline_caveat",
      "milestones",
    ],
    additionalProperties: false,
  },
};
