import type { Env, Order, ProjectClientInfo } from "./types";
import { getConfig } from "./config";
import { normalizeProject } from "./parser";
import { WEB_USER_AGENT, resolveWebAuth, webAuthHeaders, type WebAuth } from "./web-auth";

const FETCH_TIMEOUT_MS = 15000;

// Все точки Freelancer в этом модуле — закрытые веб-вызовы: нужен только
// браузерный User-Agent и заголовок freelancer-auth-v2 (см. web-auth.ts).
// Авторизацию не проверяем здесь — при 401/UNAUTHORIZED точка просто отдаёт
// null/ошибку, алерт о протухшем хэше шлёт источник данных.

// Общий fetch с веб-заголовками; без разрешённой авторизации бросает.
async function webFetch(auth: WebAuth | null, url: string, timeoutMs = FETCH_TIMEOUT_MS) {
  if (auth === null) throw new Error("веб-авторизация не настроена (fl:auth или env)");
  return fetch(url, {
    headers: { "User-Agent": WEB_USER_AGENT, ...webAuthHeaders(auth) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export interface PortfolioItem {
  id: number;
  title: string;
  description: string;
  // Прямая ссылка на элемент портфолио — в откликах ссылаемся ВСЕГДА на неё,
  // а не на профиль целиком (маршрут веб-приложения, проверено 04.10.2026).
  url: string | null;
}

export interface PortfolioInfo {
  username: string | null;
  items: PortfolioItem[];
}

const PORTFOLIO_CACHE_KEY = "portfolio:cache";
const PORTFOLIO_CACHE_TTL = 6 * 3600;
const DESCRIPTION_MAX = 700;

// Скилл "Cryptocurrency": ставки по таким проектам требуют верификации
// аккаунта (403 RESTRICTED_FROM_BIDDING_PREMIUM_VERIFIED_JOB, проверено
// 04.10.2026). Используется пре-гейтом до LLM.
export const CRYPTO_SKILL_ID = 2658;

// Портфолио профиля: title + обрезанное description (демо-ссылки живут внутри
// description и достаются LLM оттуда). Кэш KV на 6 ч — состав меняется редко.
// Любая ошибка → null (отклик пишется без портфолио-контекста).
export async function fetchPortfolio(env: Env): Promise<PortfolioInfo | null> {
  try {
    const cached = await env.ORDERS_KV.get(PORTFOLIO_CACHE_KEY);
    if (cached !== null) {
      return JSON.parse(cached) as PortfolioInfo;
    }
  } catch {
    // кэш недоступен — идём в API
  }

  const cfg = getConfig(env);
  const auth = await resolveWebAuth(env);
  let items: PortfolioItem[] = [];
  try {
    const url = new URL("https://www.freelancer.com/api/users/0.1/portfolios/");
    url.searchParams.set("limit", "12");
    url.searchParams.set("users[]", cfg.flUserId);
    url.searchParams.set("featured", "false");
    url.searchParams.set("exclude_empty_items", "true");
    url.searchParams.set("webapp", "1");
    url.searchParams.set("compact", "true");
    const res = await webFetch(auth, url.toString());
    if (res.ok) {
      const data = (await res.json()) as {
        status?: string;
        result?: { portfolios?: Record<string, unknown> };
      };
      const raw = data.result?.portfolios?.[cfg.flUserId];
      const arr = Array.isArray(raw) ? raw : [];
      items = arr
        .filter((it) => it && typeof it === "object")
        .map((it: any) => {
          const title = typeof it.title === "string" ? it.title : "";
          let description = typeof it.description === "string" ? it.description : "";
          if (description.length > DESCRIPTION_MAX) {
            description = description.slice(0, DESCRIPTION_MAX);
            const lastSpace = description.lastIndexOf(" ");
            if (lastSpace > DESCRIPTION_MAX / 2) description = description.slice(0, lastSpace);
            description += "…";
          }
          return { id: Number(it.id) || 0, title, description, url: null as string | null };
        })
        .filter((it) => it.id > 0 && it.title !== "");
    }
  } catch {
    return null;
  }
  if (items.length === 0) return null;

  // Username для прямых ссылок на элементы портфолио (закрытая точка users).
  // Маршрут элемента: /u/<username>/portfolio-item/<id> (проверено 04.10.2026).
  let username: string | null = null;
  try {
    const url = new URL("https://www.freelancer.com/api/users/0.1/users");
    url.searchParams.set("users[]", cfg.flUserId);
    url.searchParams.set("status", "true");
    url.searchParams.set("webapp", "1");
    url.searchParams.set("compact", "true");
    const res = await webFetch(auth, url.toString());
    if (res.ok) {
      const data = (await res.json()) as {
        status?: string;
        result?: { users?: Record<string, { username?: unknown } | undefined> };
      };
      const name = data.result?.users?.[cfg.flUserId]?.username;
      if (data.status === "success" && typeof name === "string") {
        username = name;
      }
    }
  } catch {
    // username не критичен
  }
  if (username) {
    for (const it of items) {
      it.url = `https://www.freelancer.com/u/${username}/portfolio-item/${it.id}`;
    }
  }

  const info: PortfolioInfo = {
    username,
    items,
  };
  try {
    await env.ORDERS_KV.put(PORTFOLIO_CACHE_KEY, JSON.stringify(info), {
      expirationTtl: PORTFOLIO_CACHE_TTL,
    });
  } catch {
    // кэш не записался — не страшно
  }
  return info;
}

// ---------- Артефакты заказа: вложения + ссылки из описания ----------

export interface OrderArtifact {
  name: string;
  source: "attachment" | "url";
  text: string;
}

const ARTIFACT_MAX_BYTES = 300_000;
const ARTIFACT_TEXT_MAX = 2500;
const ARTIFACT_TOTAL_MAX = 6000;
const URL_IN_TEXT = /https?:\/\/[^\s)<>"'\]]+/g;
const BINARY_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|png|jpe?g|gif|webp|svg|ico|css|js|mp[34]|mov|exe|dmg)(\?|#|$)/i;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateArtifact(text: string): string {
  if (text.length <= ARTIFACT_TEXT_MAX) return text;
  return text.slice(0, ARTIFACT_TEXT_MAX).trimEnd() + "…";
}

async function fetchArtifactText(url: string, name: string): Promise<OrderArtifact | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": WEB_USER_AGENT },
      signal: AbortSignal.timeout(12000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const looksBinary =
      type.includes("pdf") ||
      type.includes("word") ||
      type.includes("zip") ||
      type.includes("excel") ||
      type.includes("presentation") ||
      BINARY_EXT.test(url);
    if (looksBinary) {
      // Тело не читаем: плейсхолдер, чтобы LLM знала о существовании файла.
      const size = Number(res.headers.get("content-length") ?? 0);
      const sizePart = size > 0 ? `, ${Math.round(size / 1024)} KB` : "";
      await res.body?.cancel().catch(() => undefined);
      return { name, source: "attachment", text: `[${name}: бинарный файл (${type || "unknown"}${sizePart}) — содержимое не извлечено]` };
    }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > ARTIFACT_MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return { name, source: "attachment", text: `[${name}: файл ${Math.round(len / 1024)} KB — слишком большой, не скачан]` };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > ARTIFACT_MAX_BYTES) {
      return { name, source: "attachment", text: `[${name}: файл >${Math.round(ARTIFACT_MAX_BYTES / 1024)} KB — не скачан]` };
    }
    // Текстовое содержимое: HTML чистим до текста, остальное — как есть.
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    let text: string;
    if (type.includes("html") || /^\s*</.test(raw.slice(0, 200))) {
      text = htmlToText(raw);
    } else {
      text = raw;
    }
    text = text.replace(/[^\x09\x0A\x0D\x20-\x7EА-яёЁ]/g, " ").replace(/\s+/g, " ").trim();
    if (text === "") return null;
    return { name, source: "attachment", text: truncateArtifact(text) };
  } catch {
    return null;
  }
}

// Собирает материалы заказа для LLM: приложенные файлы (через не-compact запрос
// проекта) и страницы по ссылкам из описания. Любые ошибки → null/частичный
// набор; ничего не бросает. Воркер без парсера PDF/DOCX — бинарники плейсхолдером.
export async function fetchOrderArtifacts(env: Env, order: Order): Promise<OrderArtifact[] | null> {
  const auth = await resolveWebAuth(env);
  const out: OrderArtifact[] = [];

  // 1) Вложения: не-compact карточка проекта отдаёт attachments/files/drive_files.
  const fileUrls: { url: string; name: string }[] = [];
  try {
    const res = await webFetch(
      auth,
      `https://www.freelancer.com/api/projects/0.1/projects/?projects[]=${order.id}`,
    );
    if (res.ok) {
      const data = (await res.json()) as {
        status?: string;
        result?: { projects?: Record<string, unknown>[] };
      };
      const p = data.result?.projects?.[0] as Record<string, unknown> | undefined;
      const pools = [p?.attachments, p?.files, p?.drive_files];
      for (const pool of pools) {
        const arr = Array.isArray(pool) ? pool : [];
        for (const f of arr) {
          if (!f || typeof f !== "object") continue;
          const rec = f as Record<string, unknown>;
          const url =
            (typeof rec.url === "string" && rec.url) ||
            (typeof rec.download_url === "string" && rec.download_url) ||
            (typeof rec.file_url === "string" && rec.file_url) ||
            (typeof rec.file_id === "number" &&
              `https://www.freelancer.com/api/files/0.1/files/${rec.file_id}/`) ||
            null;
          const name =
            (typeof rec.filename === "string" && rec.filename) ||
            (typeof rec.name === "string" && rec.name) ||
            (typeof rec.title === "string" && rec.title) ||
            "attachment";
          if (url) fileUrls.push({ url, name });
        }
      }
    }
  } catch {
    // карточка проекта недоступна — остаются только ссылки из описания
  }
  for (const f of fileUrls.slice(0, 5)) {
    const art = await fetchArtifactText(f.url, f.name);
    if (art) out.push(art);
  }

  // 2) Ссылки из описания (внешние страницы; картинки исключаем, бинарники —
  // плейсхолдером, чтобы LLM знала об их существовании).
  const links = (order.description.match(URL_IN_TEXT) ?? [])
    .map((u) => u.replace(/[.,;:!?]+$/, ""))
    .filter((u) => !/freelancer\.com\//i.test(u))
    .filter((u) => !/\.(png|jpe?g|gif|webp|svg|ico)(\?|#|$)/i.test(u));
  const seen = new Set<string>();
  for (const link of links.slice(0, 5)) {
    if (seen.has(link)) continue;
    seen.add(link);
    const art = await fetchArtifactText(link, link);
    if (art) out.push({ ...art, source: "url" });
  }

  if (out.length === 0) return null;
  // Общий бюджет символов: хвост обрезаем.
  let total = 0;
  const capped: OrderArtifact[] = [];
  for (const a of out) {
    if (total + a.text.length > ARTIFACT_TOTAL_MAX) {
      const room = ARTIFACT_TOTAL_MAX - total;
      if (room > 200) capped.push({ ...a, text: a.text.slice(0, room).trimEnd() + "…" });
      break;
    }
    capped.push(a);
    total += a.text.length;
  }
  return capped;
}


// Своя копия fetchProjectsByIds: источник истины здесь, parser.ts держит
// только normalizeProject.
export async function fetchProjectsByIds(env: Env, ids: number[]): Promise<Order[]> {
  if (ids.length === 0) return [];
  const config = getConfig(env);
  const auth = await resolveWebAuth(env);
  const url = new URL(`${config.freelancerBase}/projects/`);
  for (const id of ids) url.searchParams.append("projects[]", String(id));
  url.searchParams.set("full_description", "true");
  url.searchParams.set("compact", "true");

  const response = await webFetch(auth, url.toString());
  if (!response.ok) {
    throw new Error(`fetchProjectsByIds: HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    status?: string;
    result?: { projects?: Parameters<typeof normalizeProject>[0][] };
  };
  if (data.status !== "success" || !data.result) {
    throw new Error("fetchProjectsByIds: API status not success");
  }
  return (data.result.projects ?? []).map((project) => normalizeProject(project, "alerts"));
}

// GET /api/users/0.1/users?users[]=<owner_id>&reputation=true&employer_reputation=true
//   &jobs=true&status=true&country_details=true&avatar=true&webapp=1&compact=true
// Закрытая точка: result.users[id] отдаёт status (verification-флаги),
// reputation.entire_history (рейтинг и число отзывов), employer_reputation,
// jobs (скиллы заказчика), registration_date, location.
// ownerId нет или любая ошибка (404, не-JSON, сеть, нет авторизации) → null.
export async function fetchProjectClient(
  env: Env,
  ownerId: number | null,
): Promise<ProjectClientInfo | null> {
  if (ownerId === null || !Number.isFinite(ownerId)) {
    console.warn("fetchProjectClient: owner_id отсутствует — заказчик не обогащается");
    return null;
  }
  const auth = await resolveWebAuth(env);
  const url = new URL("https://www.freelancer.com/api/users/0.1/users");
  url.searchParams.set("users[]", String(ownerId));
  url.searchParams.set("reputation", "true");
  url.searchParams.set("employer_reputation", "true");
  url.searchParams.set("jobs", "true");
  url.searchParams.set("status", "true");
  url.searchParams.set("country_details", "true");
  url.searchParams.set("avatar", "true");
  url.searchParams.set("webapp", "1");
  url.searchParams.set("compact", "true");

  let data: unknown;
  try {
    const response = await webFetch(auth, url.toString());
    if (!response.ok) return null;
    data = await response.json();
  } catch {
    return null;
  }
  const info = mapUsersResponse(data, ownerId);
  if (info === null) return null;

  // Число открытых заказов заказчика — отдельным закрытым вызовом
  // projects?owners[]=<id> (аналог бывшего other_employer_jobs из открытого
  // projects/seo). Недоступен → null, скоринг трактует как «неизвестно».
  try {
    const openUrl = new URL("https://www.freelancer.com/api/projects/0.1/projects");
    openUrl.searchParams.set("owners[]", String(ownerId));
    openUrl.searchParams.set("limit", "10");
    openUrl.searchParams.set("webapp", "1");
    openUrl.searchParams.set("compact", "true");
    const res = await webFetch(auth, openUrl.toString());
    if (res.ok) {
      const d = (await res.json()) as { result?: { projects?: unknown } };
      const list = d.result?.projects;
      info.open_projects = Array.isArray(list) ? list.length : null;
    }
  } catch {
    // open_projects остаётся null — не критично
  }
  return info;
}

// Чистый маппинг ответа точки users в ProjectClientInfo (для тестов).
export function mapUsersResponse(data: unknown, ownerId: number): ProjectClientInfo | null {
  if (typeof data !== "object" || data === null) return null;
  const result = (data as { status?: unknown; result?: unknown }).result;
  if (typeof result !== "object" || result === null) return null;
  const users = (result as { users?: unknown }).users;
  if (typeof users !== "object" || users === null) return null;
  const user = (users as Record<string, unknown>)[String(ownerId)];
  if (typeof user !== "object" || user === null) return null;
  const u = user as Record<string, unknown>;

  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const status = (u.status ?? {}) as Record<string, unknown>;
  const reputation =
    typeof u.reputation === "object" && u.reputation !== null
      ? (u.reputation as Record<string, unknown>)
      : {};
  // Имена полей рейтинга внутри entire_history не зафиксированы — читаем
  // несколько вариантов (проверено live 07.10.2026: значения числа).
  const history =
    typeof reputation.entire_history === "object" && reputation.entire_history !== null
      ? (reputation.entire_history as Record<string, unknown>)
      : {};
  const rating = num(history.rating ?? history.average ?? history.score);
  const reviewCount = num(
    history.review_count ?? history.reviews_count ?? history.number_of_reviews ?? history.reviews,
  );
  const regRaw = u.registration_date;
  const registeredTs =
    typeof regRaw === "number" ? num(regRaw) : typeof regRaw === "string" ? Date.parse(regRaw) / 1000 : null;
  const location =
    typeof u.location === "object" && u.location !== null
      ? (u.location as Record<string, unknown>)
      : {};
  const jobs = Array.isArray(u.jobs) ? u.jobs : [];
  const skillIds = jobs
    .map((j) => (j && typeof j === "object" ? Number((j as { id?: unknown }).id) : NaN))
    .filter((n) => Number.isFinite(n) && n > 0);

  return {
    payment_verified: bool(status.payment_verified),
    deposit_made: bool(status.deposit_made),
    email_verified: bool(status.email_verified),
    phone_verified: bool(status.phone_verified),
    rating,
    review_count: reviewCount,
    registered_ts:
      registeredTs !== null && Number.isFinite(registeredTs) ? registeredTs : null,
    country: typeof location.country === "string" ? location.country : null,
    open_projects: null,
    skill_ids: skillIds.length > 0 ? skillIds : null,
  };
}
