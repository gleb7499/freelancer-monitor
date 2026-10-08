import type { Env } from "./types";

// График работы авто-откликов: окно в локальном времени Europe/Minsk (UTC+3,
// переходов нет — Беларусь отменила сезонный перевод часов). Хранится в KV
// ключе `schedule` (JSON-строка). Вне окна тик пропускает опрос заказов и LLM
// (этапы по назначенным ставкам продолжают проверяться всегда).
export interface Schedule {
  startMin: number;
  endMin: number;
  enabled: boolean;
}

// Смещение UTC→Минск. Берём руками, без Intl: в Workers TZ-арифметика через
// Intl дорогая, а зона фиксированная (UTC+3 круглый год).
export const TIMEZONE_OFFSET_MS = 3 * 3600_000;

const KV_KEY = "schedule";
const DEFAULT_SCHEDULE: Schedule = { startMin: 480, endMin: 1200, enabled: true };

export async function getSchedule(env: Env): Promise<Schedule> {
  try {
    const raw = await env.ORDERS_KV.get(KV_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<Schedule>;
      if (
        typeof parsed.startMin === "number" &&
        typeof parsed.endMin === "number" &&
        typeof parsed.enabled === "boolean"
      ) {
        return { startMin: parsed.startMin, endMin: parsed.endMin, enabled: parsed.enabled };
      }
    }
  } catch (e) {
    console.warn("getSchedule: KV read/parse failed, defaulting", String(e));
  }
  return { ...DEFAULT_SCHEDULE };
}

export async function setSchedule(env: Env, s: Schedule): Promise<void> {
  await env.ORDERS_KV.put(KV_KEY, JSON.stringify(s));
}

// Чистая проверка: dateMs внутри окна [startMin, endMin) по минскому времени.
// Окно не пересекает полночь (валидация аргументов команды это запрещает).
// enabled=false — график выключен, откликаемся всегда.
export function isWithinSchedule(s: Schedule, dateMs: number): boolean {
  if (!s.enabled) return true;
  const minskMs = dateMs + TIMEZONE_OFFSET_MS;
  const minutes = Math.floor((minskMs % 86400_000) / 60000);
  return s.startMin <= minutes && minutes < s.endMin;
}

// Парсинг аргументов /schedule: "9 22" → минуты от полуночи. null — ошибка
// (вызывающий код отвечает подсказкой). Выделено отдельно, чтобы приёмка могла
// тестировать валидацию без мока KV.
export function parseScheduleArgs(
  arg: string
): { startMin: number; endMin: number } | null {
  const parts = arg.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 24)) return null;
  const [start, end] = nums;
  if (start >= end) return null;
  return { startMin: start * 60, endMin: end * 60 };
}

function fmtMin(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// Чистая функция для callback-кнопок графика (`sched:*`). Возвращает новый
// график или ошибку (next тогда = исходный s, изменений нет).
export function applyScheduleDelta(
  s: Schedule,
  action: string
): { next: Schedule; error: string | null } {
  const fail = (error: string) => ({ next: s, error });
  if (action === "t") {
    return { next: { ...s, enabled: !s.enabled }, error: null };
  }
  if (action.startsWith("p:")) {
    const parts = action.slice(2).split(":").map(Number);
    const [startMin, endMin] = parts;
    if (
      parts.length !== 2 ||
      parts.some((n) => !Number.isInteger(n)) ||
      startMin < 0 ||
      startMin > 23 * 60 ||
      endMin < 60 ||
      endMin > 24 * 60
    ) {
      return fail("недопустимый пресет");
    }
    if (startMin >= endMin) return fail("начало должно быть раньше конца");
    return { next: { ...s, startMin, endMin }, error: null };
  }
  const m = action.match(/^([se]):([+-]\d+)$/);
  if (m) {
    const delta = Number(m[2]);
    let { startMin, endMin } = s;
    if (m[1] === "s") startMin += delta;
    else endMin += delta;
    // Клемпы по допустимому диапазону + инвариант окна.
    startMin = Math.min(23 * 60, Math.max(0, startMin));
    endMin = Math.min(24 * 60, Math.max(60, endMin));
    if (startMin >= endMin) return fail("начало должно быть раньше конца");
    return { next: { ...s, startMin, endMin }, error: null };
  }
  return fail("неизвестное действие");
}

// Строка для /status и подтверждений: `08:00–20:00 (Минск), вкл`.
export function formatSchedule(s: Schedule): string {
  return `${fmtMin(s.startMin)}–${fmtMin(s.endMin)} (Минск), ${s.enabled ? "вкл" : "выкл"}`;
}
