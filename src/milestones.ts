import type { Env, Order } from "./types";
import { getConfig } from "./config";
import { fetchProjectsByIds } from "./enrich";
import { sendTelegram, alert } from "./telegram";
import { resolveWebAuth, webAuthHeaders } from "./web-auth";

export interface MilestoneCheckResult {
  dryRun: boolean;
  bidsSeen: number;
  awarded: { bid_id: number; project_id: number; amount: number; raw_status: unknown }[];
  // Запросы со сменой статуса (не создание — все этапы уходят со ставкой,
  // см. bidder.ts): переход в active/funded/released.
  requested: { bid_id: number; project_id: number; amount: number; request_id?: number; status?: string; error?: string }[];
  skipped: { bid_id: number; reason: string }[];
}

interface RawBid {
  id?: number;
  project_id?: number;
  amount?: number;
  retracted?: boolean;
  award_status?: unknown;
  frontend_bid_status?: unknown;
  time_awarded?: unknown;
  [key: string]: unknown;
}

// Состояние этапных запросов ставки — пишет bidder.ts при размещении ставки:
// KV ms:req:<bid_id> = {project_id, requests:[{id, amount, description}], ts}.
interface StoredRequest {
  id?: number;
  amount?: number;
  description?: string;
  status?: string;
}

interface RawMilestoneRequest {
  id?: number;
  status?: unknown;
  [key: string]: unknown;
}

// Детект назначения ставки — толерантный: точные значения award_status /
// frontend_bid_status по живой назначенной ставке пока неизвестны, поэтому
// ловим либо заполненный time_awarded, либо строку со "award"/"accept".
export function isAwarded(bid: RawBid): boolean {
  if (typeof bid.time_awarded === "number") return true;
  for (const field of [bid.award_status, bid.frontend_bid_status]) {
    if (typeof field === "string" && /award|accept/i.test(field)) return true;
  }
  return false;
}

const KV_LAST_CHECK = "ms:last_check";
const THROTTLE_SEC = 300;
const KV_REQ_PREFIX = "ms:req:";
const KV_AWARD_PREFIX = "ms:award:";
const KV_STATE_TTL = 60 * 86400;

// Статусы этапных запросов, о переходе в которые алертим работодателю
// (деньги зарезервированы/выпущены). Новые терминальные значения, отличные от
// сохранённого, тоже алертим — список живого API может быть шире.
const ALERT_STATUSES = new Set(["active", "funded", "released"]);

async function fetchMyBids(
  base: string,
  userId: string,
  authHeaders: Record<string, string>,
): Promise<RawBid[]> {
  const res = await fetch(`${base}/bids/?bidders[]=${userId}`, {
    headers: authHeaders,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`fetchMyBids: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { status?: string; result?: { bids?: unknown } };
  if (data.status !== "success") {
    throw new Error("fetchMyBids: API status not success");
  }
  const bids = data.result?.bids;
  if (Array.isArray(bids)) return bids as RawBid[];
  if (bids && typeof bids === "object") return Object.values(bids) as RawBid[];
  return [];
}

// Статусы этапных запросов ставки: GET /milestone_requests/?bids[]=<bid_id>.
// Ответ тот же конверт, что у fetchMyBids: result.milestone_requests — словарь
// или список, разбираем оба. Ошибка/не-ok → null (молча пропускаем, тик не ломаем).
async function fetchBidRequestStatuses(
  base: string,
  bidId: number,
  authHeaders: Record<string, string>,
): Promise<Map<number, string> | null> {
  try {
    const res = await fetch(`${base}/milestone_requests/?bids[]=${bidId}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: string;
      result?: { milestone_requests?: unknown };
    };
    if (data.status !== "success") return null;
    const raw = data.result?.milestone_requests;
    const list: RawMilestoneRequest[] = Array.isArray(raw)
      ? (raw as RawMilestoneRequest[])
      : raw && typeof raw === "object"
        ? (Object.values(raw) as RawMilestoneRequest[])
        : [];
    const out = new Map<number, string>();
    for (const mr of list) {
      if (typeof mr?.id === "number" && typeof mr.status === "string") {
        out.set(mr.id, mr.status);
      }
    }
    return out;
  } catch {
    return null;
  }
}

async function projectLabel(env: Env, projectId: number): Promise<{ part: string; sign: string }> {
  let order: Order | undefined;
  try {
    order = (await fetchProjectsByIds(env, [projectId]))[0];
  } catch {
    order = undefined;
  }
  return {
    part: order ? order.url : `project #${projectId}`,
    sign: order?.currency_sign ?? "$",
  };
}

export async function checkMilestones(
  env: Env,
  opts?: { dryRun?: boolean; force?: boolean },
): Promise<MilestoneCheckResult> {
  const dryRun = opts?.dryRun ?? false;
  const result: MilestoneCheckResult = { dryRun, bidsSeen: 0, awarded: [], requested: [], skipped: [] };

  const cfg = getConfig(env);

  // Авторизация: основной путь — веб (freelancer-auth-v2), фолбэк —
  // OAuth-токен либо ключ Develop API (закрытые точки принимают Bearer,
  // проверено 04.10.2026).
  const webAuth = await resolveWebAuth(env);
  const authHeaders: Record<string, string> | null = webAuth
    ? webAuthHeaders(webAuth)
    : cfg.flOauthToken
      ? { "Freelancer-OAuth-V1": cfg.flOauthToken }
      : cfg.flApiKey
        ? { Authorization: `Bearer ${cfg.flApiKey}` }
        : null;
  if (!authHeaders) {
    result.skipped.push({ bid_id: 0, reason: "oauth-missing" });
    return result;
  }
  const userId = webAuth?.userId ?? cfg.flUserId;
  if (!userId) {
    result.skipped.push({ bid_id: 0, reason: "fl-user-id-missing" });
    return result;
  }

  // Троттлинг: не чаще раза в 5 минут (обход — только force).
  const now = Date.now();
  if (!opts?.force) {
    const lastRaw = await env.ORDERS_KV.get(KV_LAST_CHECK);
    const last = lastRaw ? Number(lastRaw) : 0;
    if (now - last < THROTTLE_SEC * 1000) {
      result.skipped.push({ bid_id: 0, reason: "throttled" });
      return result;
    }
  }

  // --- Детект назначения: наши ставки → awarded-алерт (один раз на ставку).
  let bids: RawBid[] = [];
  try {
    bids = await fetchMyBids(cfg.freelancerBase, userId, authHeaders);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("HTTP 401")) {
      result.skipped.push({ bid_id: 0, reason: "oauth-invalid" });
      await alert(env, "Milestones: авторизация отклонена (401)");
      return result;
    }
    throw e;
  }
  result.bidsSeen = bids.length;
  if (!opts?.force) {
    await env.ORDERS_KV.put(KV_LAST_CHECK, String(now), { expirationTtl: 3600 });
  }

  for (const bid of bids) {
    if (bid.retracted || !isAwarded(bid)) continue;
    const bidId = Number(bid.id);
    const projectId = Number(bid.project_id);
    const bidAmount = Number(bid.amount);
    if (!Number.isFinite(bidId) || !Number.isFinite(projectId)) continue;

    // Сырые поля назначения логируем: по первому живому назначению
    // подкорректируем эвристику isAwarded.
    console.log("milestones.awarded-bid", {
      bid_id: bidId,
      project_id: projectId,
      award_status: bid.award_status,
      frontend_bid_status: bid.frontend_bid_status,
      time_awarded: bid.time_awarded,
    });
    result.awarded.push({
      bid_id: bidId,
      project_id: projectId,
      amount: bidAmount,
      raw_status: bid.award_status ?? bid.frontend_bid_status,
    });

    // Дедуп: алертим один раз на ставку (KV ms:award:<bid_id>).
    const awardKey = `${KV_AWARD_PREFIX}${bidId}`;
    const alreadyAlerted = await env.ORDERS_KV.get(awardKey);
    if (alreadyAlerted !== null) continue;
    if (dryRun) continue;
    try {
      await env.ORDERS_KV.put(awardKey, String(now), { expirationTtl: KV_STATE_TTL });
    } catch {
      // не записалось — алертим в следующий раз, дубль маловероятен
    }
    const { part, sign } = await projectLabel(env, projectId);
    await sendTelegram(
      env,
      `🏆 Ставка назначена!\n\nПроект: ${part}\nСтавка: ${sign}${bidAmount} (bid #${bidId})\nВсе этапы уже запрошены — жди принятия работодателем.`,
    );
  }

  // --- Опрос статусов этапных запросов наших ставок (KV ms:req:<bid_id>).
  let listed: { keys: { name: string }[] };
  try {
    listed = await env.ORDERS_KV.list({ prefix: KV_REQ_PREFIX });
  } catch {
    listed = { keys: [] };
  }
  for (const key of listed.keys) {
    const bidId = Number(key.name.slice(KV_REQ_PREFIX.length));
    if (!Number.isFinite(bidId)) continue;

    let state: { project_id?: number; requests?: StoredRequest[]; ts?: number } | null = null;
    try {
      const raw = await env.ORDERS_KV.get(key.name);
      if (raw !== null) {
        state = JSON.parse(raw) as { project_id?: number; requests?: StoredRequest[]; ts?: number };
      }
    } catch {
      state = null;
    }
    if (state === null || !Array.isArray(state.requests) || state.requests.length === 0) {
      result.skipped.push({ bid_id: bidId, reason: "no-state" });
      continue;
    }
    const projectId = Number(state.project_id);

    if (dryRun) {
      for (const r of state.requests) {
        result.requested.push({
          bid_id: bidId,
          project_id: projectId,
          amount: Number(r.amount) || 0,
          request_id: r.id,
          status: r.status ?? "unknown",
        });
      }
      continue;
    }

    const statuses = await fetchBidRequestStatuses(cfg.freelancerBase, bidId, authHeaders);
    if (statuses === null) {
      result.skipped.push({ bid_id: bidId, reason: "status-fetch-failed" });
      continue;
    }

    let stateChanged = false;
    for (const r of state.requests) {
      const requestId = typeof r.id === "number" ? r.id : null;
      if (requestId === null) continue;
      const current = statuses.get(requestId);
      if (current === undefined) continue;
      const prev = r.status ?? null;
      if (current === prev) continue;
      r.status = current;
      stateChanged = true;
      const amount = Number(r.amount) || 0;
      const isAlertable = ALERT_STATUSES.has(current) || (prev !== null && ALERT_STATUSES.has(prev));
      if (!isAlertable) continue;
      result.requested.push({
        bid_id: bidId,
        project_id: projectId,
        amount,
        request_id: requestId,
        status: current,
      });
      const { part, sign } = await projectLabel(env, projectId);
      await sendTelegram(
        env,
        `💰 Этап по проекту ${part}: ${current} (${sign}${amount}, запрос #${requestId})`,
      );
    }
    if (stateChanged) {
      try {
        await env.ORDERS_KV.put(key.name, JSON.stringify(state), { expirationTtl: KV_STATE_TTL });
      } catch {
        // статусы не записались — переалертим на следующем тике (дедупа нет)
      }
    }
  }

  return result;
}
