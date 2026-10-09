import type { Env, Order, ScoreResult } from "./types";

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

// Курс родной валюты за 1 USD — восстанавливается из бюджета заказа.
function orderRate(order: Order): number {
  return order.budget_min > 0 && order.budget_min_original > 0
    ? order.budget_min_original / order.budget_min
    : 1;
}

function truncateText(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).trimEnd() + "…";
}

// Компактная карточка отказа (PASS): без ставки, сроков, апгрейдов и прочих
// полей, бессмысленных для отказа — оператор быстро сканирует, почему пропуск.
export function formatPassCard(order: Order, score: ScoreResult): string {
  const parts: string[] = [];
  const typeLabel = order.type === "hourly" ? "hourly" : "fixed";
  parts.push(`📡 ${order.source ?? "active"} — 💼 <b>${escHtml(order.title)}</b>\n${escHtml(order.niche_id)} · ${typeLabel}`);
  parts.push(`💰 Бюджет: ${budgetLine(order)}`);
  parts.push(`👥 Откликов: ${order.bids}`);
  parts.push(`✅ PASS — ${escHtml(score.reason)}`);
  if (score.red_flags.length > 0) {
    parts.push(`🚩 ${escHtml(score.red_flags.join("; "))}`);
  }
  parts.push(`🔗 <a href="${escHtml(order.url)}">Открыть заказ</a>`);
  return parts.join("\n\n");
}

// Блок ручных действий в карточке BID: sealed покупает код автоматически
// (через корзину платежей), ручных действий по нему нет; sponsored — единственный
// ручной/полуручной апгрейд: на усмотрение оператора по статусу слота.
// bidId=null в test-режиме (ставка не размещена — ссылки нет).
export interface ManualActions {
  bidId: number | null;
  // null — слот не проверен (запрос bids не удался).
  slotFree: boolean | null;
  // Ценовая метка sponsored из priceUpgrades, напр. "sponsored ~$1.90".
  sponsoredPrice: string;
  // Если код выкинул sponsored из плана — причина вместо статуса слота.
  sponsoredRemovedNote?: string;
  // Test-режим: ставка не размещена, ссылку на bid не печатаем.
  test?: boolean;
}

// Карточка только для вердикта BID (после placeBid).
export function formatOrderCard(
  order: Order,
  score: ScoreResult,
  bidText: string | null,
  manualActions?: ManualActions | null,
): string {
  const values: Record<string, string> = {
    REASON: escHtml(score.reason),
    REDFLAGS: escHtml(score.red_flags.join("; ")),
    CHECKMANUALLY: escHtml(score.check_manually.join("; ")),
  };

  const parts: string[] = [];
  const typeLabel = order.type === "hourly" ? "hourly" : "fixed";
  parts.push(`📡 ${order.source ?? "active"} — 💼 <b>${escHtml(order.title)}</b>\n${escHtml(order.niche_id)} · ${typeLabel}`);
  parts.push(`💰 Бюджет: ${budgetLine(order)}`);
  const avgPart = order.bid_avg != null ? ` (ср. $${order.bid_avg})` : "";
  parts.push(`👥 Откликов: ${order.bids}${avgPart}`);

  parts.push(`✅ Вердикт: ${score.verdict} — ${values.REASON}`);
  if (score.verdict === "BID") {
    const sign = order.currency_sign;
    let line = `💵 Ставка: ${sign}${score.bid_amount} → на руки ${sign}${score.net_amount}`;
    if (order.currency_code !== "USD") {
      const r = orderRate(order);
      line += ` (≈$${Math.round(score.bid_amount / r)} / ≈$${Math.round(score.net_amount / r)})`;
    }
    parts.push(line);
  }
  if (order.type === "hourly" && score.weekly_limit_hours !== null) {
    parts.push(`⏱ Weekly limit: ${score.weekly_limit_hours} ч/нед`);
  }
  const deadlinePart =
    score.deadline_caveat != null ? `; дедлайн: ${escHtml(score.deadline_caveat)}` : "";
  parts.push(`⏱ Срок: ${score.delivery_days} дн${deadlinePart}`);
  if (score.red_flags.length > 0) {
    parts.push(`🚩 Красные флаги: ${values.REDFLAGS}`);
  }
  if (score.check_manually.length > 0) {
    parts.push(`⚠️ Проверь вручную: ${values.CHECKMANUALLY}`);
  }
  if (order.is_seller_kyc_required) {
    parts.push(`🪪 Нужна верификация аккаунта для ставки`);
  }

  if (bidText) {
    parts.push(`✉️ Текст ставки (EN):\n<blockquote>${escHtml(bidText)}</blockquote>`);
  }

  // Этапы оплаты (fixed): все запросы уходят сразу со ставкой (bidder.ts),
  // здесь только показ плана работодателю. Доля = amount/ставка.
  if (score.milestones !== null && score.milestones.length > 0) {
    const lines = ["📌 Этапы оплаты (уже запрошены):"];
    for (const m of score.milestones) {
      const share = score.bid_amount > 0 ? Math.round((m.amount / score.bid_amount) * 100) : 0;
      lines.push(`${share}% - ${escHtml(m.description)}: ${order.currency_sign}${m.amount}`);
    }
    parts.push(lines.join("\n"));
  }

  // Консоль действий: sponsored — по статусу слота (sealed — автоматически).
  if (manualActions) {
    const ma = manualActions;
    const lines = ["🛠 Ручные действия:"];
    if (ma.sponsoredRemovedNote) {
      lines.push(`1. ${ma.sponsoredPrice} - не берём: ${escHtml(ma.sponsoredRemovedNote)}`);
    } else if (score.take_upgrades.includes("sponsored")) {
      const slot = ma.slotFree === null ? "не проверен" : ma.slotFree ? "свободен" : "занят";
      lines.push(`1. ${ma.sponsoredPrice} - слот ${slot} (по желанию)`);
    } else {
      lines.push("1. Нет — sealed куплен автоматически, sponsored не нужен");
    }
    parts.push(lines.join("\n"));
  }

  parts.push(`🔗 <a href="${escHtml(order.url)}">Открыть заказ</a>`);

  let text = parts.join("\n\n");
  // Shrink in priority order: flags, check_manually, reason, then bid text as
  // last resort. Text content only — tags (b/blockquote/a) stay paired.
  const shrinkTargets = [
    { marker: values.REDFLAGS, raw: score.red_flags.join("; ") },
    { marker: values.CHECKMANUALLY, raw: score.check_manually.join("; ") },
    { marker: values.REASON, raw: score.reason },
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

// Короткая карточка отказа на этапе до LLM (test-режим: объясняем причину).
export function formatRejectCard(order: Order, reason: string): string {
  const parts: string[] = [];
  const typeLabel = order.type === "hourly" ? "hourly" : "fixed";
  parts.push(`📡 ${order.source ?? "active"} — 💼 <b>${escHtml(order.title)}</b>\n${escHtml(order.niche_id)} · ${typeLabel}`);
  parts.push(`💰 Бюджет: ${budgetLine(order)}`);
  parts.push(`👥 Откликов: ${order.bids}`);
  parts.push(`⛔ Отклонён: ${escHtml(reason)}`);
  parts.push(`🔗 <a href="${escHtml(order.url)}">Открыть заказ</a>`);
  return parts.join("\n\n");
}

export async function sendTelegram(
  env: Env,
  text: string,
  replyMarkup?: { inline_keyboard: { text: string; callback_data: string }[][] },
): Promise<void> {
  // Локальный прогон (DEV_MARKER=1 в .dev.vars): помечаем сообщения, чтобы
  // не смешиваться с продом в одном чате (у dev своя D1 seen, дедуп общего
  // чата на уровне кода невозможен).
  if (env.DEV_MARKER === "1" && !text.startsWith("[DEV]")) {
    text = `[DEV] ${text}`;
  }
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
// Экспортирована: перерегистрируется на каждую команду из вебхука (см. index.ts),
// чтобы меню не протухало после деплоев (раньше обновлялось только в setWebhook).
export async function setMyCommands(env: Env): Promise<unknown> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "mode", description: "Режим: /mode test | live | off" },
        { command: "schedule", description: "График откликов: /schedule 9 22 | on | off" },
        { command: "status", description: "Режим, график, баланс bids, статистика за сутки" },
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
