import type { Order } from "./types";
import { RULES_FREELANCER_SELECTION, RULES_BID_SKILL, RULES_HUMANIZE } from "./generated/rules";
import scoringSystemMd from "../prompts/scoring-system.md";
import scoringUserMd from "../prompts/scoring-user.md";
import scoringRetryMd from "../prompts/scoring-retry.md";
import bidTextSystemMd from "../prompts/bid-text-system.md";
import bidUserMd from "../prompts/bid-user.md";
import bidUserWeeklyMd from "../prompts/bid-user-weekly.md";
import bidUserPortfolioMd from "../prompts/bid-user-portfolio.md";
import bidUserMilestonesMd from "../prompts/bid-user-milestones.md";
import bidUserPriceMd from "../prompts/bid-user-price.md";
import humanizeSystemMd from "../prompts/humanize-system.md";
import humanizeLimitMd from "../prompts/humanize-limit.md";

export interface ScoringPromptOptions {
  weeklyLimitHours: number;
  targetHourly: number;
  bidMinScore: number;
}

export interface ScoringContext {
  bidsBalance: number | null;
  nextBidInMinutes: number | null;
  // Остаток дневного лимита sponsored-покупок (null — KV недоступен).
  sponsoredLeft: number | null;
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

export function buildScoringSystemPrompt(opts: ScoringPromptOptions): string {
  return fill(text(scoringSystemMd), {
    RULES_FREELANCER_SELECTION,
    BID_MIN_SCORE: String(opts.bidMinScore),
    TARGET_HOURLY: String(opts.targetHourly),
    WEEKLY_LIMIT_HOURS: String(opts.weeklyLimitHours),
  });
}

export function buildScoringUserMessage(order: Order, ctx?: ScoringContext): string {
  const head = fill(text(scoringUserMd), {
    BIDS_BALANCE: ctx && ctx.bidsBalance !== null ? String(ctx.bidsBalance) : "unknown",
    NEXT_BID_MINUTES:
      ctx && ctx.nextBidInMinutes !== null ? String(ctx.nextBidInMinutes) : "unknown",
    SPONSORED_LEFT: ctx && ctx.sponsoredLeft !== null ? String(ctx.sponsoredLeft) : "unknown",
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

export const BID_TEXT_SYSTEM_PROMPT = fill(text(bidTextSystemMd), { RULES_BID_SKILL });

export const BID_TEXT_MAX_CHARS = 1500;

// Второй проход редактуры: humanize-промт из rules/humanize.md (приоритетные
// правила проекта в его конце). Ошибка этого вызова не фатальна — берём черновик.
export const HUMANIZE_SYSTEM_PROMPT = fill(text(humanizeSystemMd), { RULES_HUMANIZE });

export function buildHumanizeLimitMessage(charCount: number, maxChars: number): string {
  return fill(text(humanizeLimitMd), {
    CHAR_COUNT: String(charCount),
    MAX_CHARS: String(maxChars),
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

export function buildBidMilestonesNote(milestonesRest: string, milestonesFull: string): string {
  return fill(text(bidUserMilestonesMd), {
    MILESTONES_REST: milestonesRest,
    MILESTONES_FULL: milestonesFull,
  });
}

export function buildBidPriceNote(bidAmount: number, currency: string): string {
  return fill(text(bidUserPriceMd), {
    BID_AMOUNT: String(bidAmount),
    CURRENCY: currency,
  });
}

// Обёртка пользовательского сообщения генератора текста ставки.
export function buildBidUserMessage(orderJson: string, scoreJson: string, notes: string): string {
  return fill(text(bidUserMd), { ORDER_JSON: orderJson, SCORE_JSON: scoreJson, NOTES: notes });
}

export const SCORING_JSON_SCHEMA = {
  name: "order_score",
  strict: true,
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["BID", "PASS"] },
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
      take_upgrades: {
        type: "array",
        items: { type: "string", enum: ["sealed", "sponsored"] },
      },
    },
    required: [
      "verdict",
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
      "take_upgrades",
    ],
    additionalProperties: false,
  },
};
