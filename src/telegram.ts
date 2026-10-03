import type { Env, Order, ScoreResult, UpgradeId } from "./types";
import { priceUpgrades, totalPrice } from "./upgrades";

export class TelegramError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
  }
}

const LIMIT = 4096;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatThousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function usdRange(min: number, max: number): string {
  const lo = Math.round(min);
  const hi = Math.round(max);
  return lo === hi ? `$${lo}` : `$${lo}–$${hi}`;
}

function originalRange(order: Order): string {
  const { currency_sign: sign, currency_code: code } = order;
  const lo = formatThousands(order.budget_min_original);
  const hi = formatThousands(order.budget_max_original);
  const range =
    order.budget_min_original === order.budget_max_original
      ? `${sign}${lo}`
      : `${sign}${lo}–${sign}${hi}`;
  return `${range} ${code}`;
}

function budgetLine(order: Order): string {
  const suffix = order.type === "hourly" ? "/ч" : "";
  const usd = usdRange(order.budget_min, order.budget_max);
  if (order.currency_code !== "USD") {
    return `${originalRange(order)}${suffix} (≈${usd}${suffix})`;
  }
  return `${usd}${suffix}`;
}

function truncateText(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).trimEnd() + "…";
}

// Карточка только для вердикта BID (после placeBid). PASS в Telegram не идёт.
export function formatOrderCard(
  order: Order,
  score: ScoreResult,
  bidText: string | null,
  removedUpgrades?: UpgradeId[],
): string {
  const values: Record<string, string> = {
    SUMMARY: escHtml(score.summary_ru),
    REASON: escHtml(score.reason),
    REDFLAGS: escHtml(score.red_flags.join("; ")),
    CHECKMANUALLY: escHtml(score.check_manually.join("; ")),
  };

  const parts: string[] = [];
  const typeLabel = order.type === "hourly" ? "hourly" : "fixed";
  parts.push(`📡 alert — 💼 <b>${escHtml(order.title)}</b>\n${escHtml(order.niche_id)} · ${typeLabel}`);
  parts.push(`💰 Бюджет: ${budgetLine(order)}`);
  const avgPart = order.bid_avg != null ? ` (ср. $${order.bid_avg})` : "";
  parts.push(`👥 Откликов: ${order.bids}${avgPart}`);
  parts.push(`📝 Суть: ${values.SUMMARY}`);

  parts.push(
    `🎯 Value: ${score.value_score}/100 (~$${Math.round(score.bid_amount / Math.max(1, score.ai_hours))}/ч при ${score.ai_hours} AI-ч)`,
  );
  parts.push(`✅ Вердикт: ${score.verdict} — ${values.REASON}`);
  parts.push(`💵 Ставка: $${score.bid_amount} → на руки $${score.net_amount}`);
  if (order.type === "hourly" && score.weekly_limit_hours !== null) {
    parts.push(`⏱ Weekly limit: ${score.weekly_limit_hours} ч/нед`);
  }
  parts.push(
    `⏱ Срок: ${score.delivery_days} дн (оценка ${score.hours.opt}/${score.hours.real}/${score.hours.pess} ч)`,
  );
  if (score.red_flags.length > 0) {
    parts.push(`🚩 Красные флаги: ${values.REDFLAGS}`);
  }
  if (score.deadline_caveat != null) {
    parts.push(`📅 Дедлайн: ${escHtml(score.deadline_caveat)}`);
  }
  if (score.check_manually.length > 0) {
    parts.push(`⚠️ Проверь вручную: ${values.CHECKMANUALLY}`);
  }
  if (score.take_upgrades.length > 0) {
    const prices = priceUpgrades(score.take_upgrades, score.bid_amount);
    const approx = prices.some((p) => p.approx);
    const total = totalPrice(prices);
    parts.push(
      `🎟 Апгрейды: ${prices.map((p) => p.label).join(", ")} (итого ${approx ? "~" : ""}$${total.toFixed(2)})`,
    );
    if (score.take_upgrades.includes("sponsored")) {
      parts.push(
        `⚠️ На форме проверь: если написано rank #2 — спонсор уже занят, сними галочку`,
      );
    }
  }
  if (removedUpgrades && removedUpgrades.length > 0) {
    parts.push(`✂️ Срезано по потолку 3%/$3: ${removedUpgrades.join(", ")}`);
  }
  if (order.is_seller_kyc_required) {
    parts.push(`🪪 Нужна верификация аккаунта для ставки`);
  }

  if (bidText) {
    parts.push(`✉️ Текст ставки (EN):\n<blockquote>${escHtml(bidText)}</blockquote>`);
  }

  parts.push(`🔗 <a href="${escHtml(order.url)}">Открыть заказ</a>`);

  let text = parts.join("\n\n");

  // Shrink in priority order: summary, reason, flags, check_manually, then bid
  // as last resort. Text content only — tags (b/blockquote/a) stay paired.
  const shrinkTargets = [
    { marker: values.SUMMARY, raw: score.summary_ru },
    { marker: values.REASON, raw: score.reason },
    { marker: values.REDFLAGS, raw: score.red_flags.join("; ") },
    { marker: values.CHECKMANUALLY, raw: score.check_manually.join("; ") },
    { marker: bidText ? escHtml(bidText) : "", raw: bidText ?? "", suffix: "…(truncated)" },
  ];

  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let guard = 0;
  while (text.length > LIMIT && guard++ < 50) {
    let changed = false;
    for (const t of shrinkTargets) {
      if (!t.marker || !text.includes(t.marker)) continue;
      const over = text.length - LIMIT;
      const suffixLen = (t.suffix ?? "").length;
      const newLen = t.raw.length - over - 10 - suffixLen;
      if (newLen <= 0) {
        text = text.replace(
          new RegExp(`^.*${escapeRegExp(t.marker)}$\n?`, "m"),
          "",
        );
      } else {
        text = text.replace(
          t.marker,
          escHtml(truncateText(t.raw, newLen) + (t.suffix ?? "")),
        );
      }
      changed = true;
      break;
    }
    if (!changed) break;
  }

  return text;
}

export async function sendTelegram(
  env: Env,
  text: string,
  replyMarkup?: { inline_keyboard: { text: string; callback_data: string }[][] },
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  let body: Record<string, unknown> = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  };
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
  let res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 400 && text.length > 4000) {
      body = { ...body, text: text.slice(0, 4000) };
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    }
    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 300);
      throw new TelegramError(res.status, snippet);
    }
  }
}

export async function setWebhook(env: Env, webhookUrl: string): Promise<unknown> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const commands = await setMyCommands(env);
  return { status: res.status, body: text, commands };
}

// Меню команд бота (кнопка «/» в чате). BotFather не нужен — это Bot API.
async function setMyCommands(env: Env): Promise<unknown> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "mode", description: "Режим: /mode test | live | off" },
        { command: "status", description: "Режим, баланс bids, статистика за сутки" },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, body: await res.text() };
}

export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    signal: AbortSignal.timeout(15000),
  });
}

// Заменить текст сообщения (и убрать клавиатуру, если не передана).
export async function editMessage(
  env: Env,
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: { inline_keyboard: { text: string; callback_data: string }[][] },
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  };
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

// Удалить сообщение (свою команду-эхо или служебное сообщение бота).
export async function deleteMessage(
  env: Env,
  chatId: number | string,
  messageId: number,
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    signal: AbortSignal.timeout(15000),
  });
}

export async function alert(env: Env, text: string): Promise<void> {
  const key = "tg:alert";
  const existing = await env.ORDERS_KV.get(key);
  if (existing) return;
  try {
    await sendTelegram(env, `⚠️ ${escHtml(text)}`);
    await env.ORDERS_KV.put(key, "1", { expirationTtl: 3600 });
  } catch (err) {
    console.warn("alert failed:", err);
  }
}
