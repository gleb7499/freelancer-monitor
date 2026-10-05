import type { Env, Order } from "./types";
import { getConfig } from "./config";
import { fetchProjectsByIds } from "./enrich";
import { sendTelegram, alert } from "./telegram";

export interface MilestoneCheckResult {
  dryRun: boolean;
  bidsSeen: number;
  awarded: { bid_id: number; project_id: number; amount: number; raw_status: unknown }[];
  requested: { bid_id: number; project_id: number; amount: number; request_id?: number; error?: string }[];
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
const KV_REQ_TTL = 60 * 86400;
const KICKOFF_RATIO = 0.3;

// Статус последнего milestone-запроса по id (null — не найден/ошибка).
async function fetchMilestoneRequestStatus(
  cfg: { freelancerBase: string; flOauthToken: string; flApiKey: string },
  authHeaders: Record<string, string>,
  requestId: number | null,
): Promise<string | null> {
  if (requestId === null) return null;
  try {
    const res = await fetch(
      `${cfg.freelancerBase}/milestone_requests/?milestone_requests[]=${requestId}`,
      { headers: authHeaders, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: string;
      result?: { milestone_requests?: Record<string, { status?: unknown }> };
    };
    const mr = data.result?.milestone_requests?.[String(requestId)];
    return typeof mr?.status === "string" ? mr.status : null;
  } catch {
    return null;
  }
}

async function fetchMyBids(
  env: Env,
  userId: string,
  base: string,
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

export async function checkMilestones(
  env: Env,
  opts?: { dryRun?: boolean; force?: boolean },
): Promise<MilestoneCheckResult> {
  const dryRun = opts?.dryRun ?? false;
  const result: MilestoneCheckResult = { dryRun, bidsSeen: 0, awarded: [], requested: [], skipped: [] };

  const cfg = getConfig(env);
  if (!cfg.flOauthToken && !cfg.flApiKey) {
    result.skipped.push({ bid_id: 0, reason: "oauth-missing" });
    return result;
  }
  if (!cfg.flUserId) {
    result.skipped.push({ bid_id: 0, reason: "fl-user-id-missing" });
    return result;
  }

  // Авторизация: основной путь — OAuth-токен аккаунта; фолбэк — ключ Develop API
  // (закрытые точки принимают Authorization: Bearer, проверено 04.10.2026).
  const authHeaders: Record<string, string> = cfg.flOauthToken
    ? { "Freelancer-OAuth-V1": cfg.flOauthToken }
    : { Authorization: `Bearer ${cfg.flApiKey}` };

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

  const bids = await fetchMyBids(env, cfg.flUserId, cfg.freelancerBase, authHeaders);
  result.bidsSeen = bids.length;
  if (!opts?.force) {
    await env.ORDERS_KV.put(KV_LAST_CHECK, String(now), { expirationTtl: 3600 });
  }

  const awarded = bids.filter((b) => !b.retracted && isAwarded(b));
  for (const bid of awarded) {
    const bidId = Number(bid.id);
    const projectId = Number(bid.project_id);
    const bidAmount = Number(bid.amount);
    if (!Number.isFinite(bidId) || !Number.isFinite(projectId)) continue;

    // Сырые статусы логируем: по первому живому назначению подкорректируем детект.
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

    // Состояние цепочки этапов: KV ms:req:<bid_id> = {next_index, plan, requested[]}.
    // План приходит из bidder.ts (ms:plan:<bid_id>), fallback [30, 70].
    const dedupKey = `${KV_REQ_PREFIX}${bidId}`;
    let state: { next_index: number; plan: number[]; requested: { amount: number; request_id: number | null }[] } | null = null;
    try {
      const raw = await env.ORDERS_KV.get(dedupKey);
      if (raw !== null) state = JSON.parse(raw);
    } catch {
      state = null;
    }
    if (state === null) {
      let plan = [30, 70];
      try {
        const planRaw = await env.ORDERS_KV.get(`ms:plan:${bidId}`);
        if (planRaw !== null) {
          const parsed = JSON.parse(planRaw) as { plan?: unknown };
          if (Array.isArray(parsed.plan) && parsed.plan.length >= 2 && parsed.plan.length <= 4) {
            plan = parsed.plan.map(Number);
          }
        }
      } catch {
        // fallback-план
      }
      state = { next_index: 0, plan, requested: [] };
    }
    if (state.next_index >= state.plan.length) {
      result.skipped.push({ bid_id: bidId, reason: "plan-complete" });
      continue;
    }

    // Этап 2+ запрашиваем только когда предыдущий выпущен (Released).
    if (state.next_index > 0) {
      const last = state.requested[state.requested.length - 1];
      const status = await fetchMilestoneRequestStatus(cfg, authHeaders, last?.request_id ?? null);
      if (status === "pending" || status === "active" || status === "created" || status === "funded") {
        result.skipped.push({ bid_id: bidId, reason: "awaiting-release" });
        continue;
      }
      if (status !== "released" && status !== null) {
        result.skipped.push({ bid_id: bidId, reason: `prev-${status}` });
        continue;
      }
    }

    const share = state.plan[state.next_index];
    const amount = Math.round(bidAmount * (share / 100) * 100) / 100;
    if (!(amount > 0)) {
      result.skipped.push({ bid_id: bidId, reason: "zero-amount" });
      continue;
    }
    const stageNo = state.next_index + 1;
    const stageTotal = state.plan.length;
    const description =
      stageNo === 1
        ? "Kickoff milestone - 30% upfront to start work; the remainder on delivery."
        : `Milestone ${stageNo} of ${stageTotal} (${share}%).`;

    if (dryRun) {
      result.requested.push({ bid_id: bidId, project_id: projectId, amount });
      continue;
    }

    let res: Response;
    try {
      res = await fetch(`${cfg.freelancerBase}/milestone_requests/`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project_id: projectId, bid_id: bidId, amount, description }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      result.requested.push({
        bid_id: bidId,
        project_id: projectId,
        amount,
        error: String(e).slice(0, 300),
      });
      continue;
    }

    if (res.ok) {
      let requestId: number | undefined;
      try {
        const data = (await res.json()) as { result?: { id?: number } };
        requestId = data.result?.id;
      } catch {
        // id не критичен
      }
      state.requested.push({ amount, request_id: requestId ?? null });
      state.next_index += 1;
      try {
        await env.ORDERS_KV.put(dedupKey, JSON.stringify(state), { expirationTtl: KV_REQ_TTL });
      } catch {
        // состояние не записалось — повторим на следующем тике (дедупа нет, риск
        // двойного запроса приблизительно = нулю: клиенту нужно принять каждый)
      }
      result.requested.push({ bid_id: bidId, project_id: projectId, amount, request_id: requestId });
      let order: Order | undefined;
      try {
        order = (await fetchProjectsByIds(env, [projectId]))[0];
      } catch {
        order = undefined;
      }
      const sign = order?.currency_sign ?? "$";
      const projectPart = order ? order.url : `project #${projectId}`;
      await sendTelegram(
        env,
        `💰 Запрошен этап оплаты (${stageNo}/${stageTotal})\n\nПроект: ${projectPart}\nЭтап: ${sign}${amount} (${share}% от ставки ${sign}${bidAmount})\nЗапрос #${requestId ?? "?"} — ждёт принятия работодателем.`,
      );
      continue;
    }

    const text = (await res.text()).slice(0, 300);
    if (res.status === 401) {
      result.skipped.push({ bid_id: bidId, reason: "oauth-invalid" });
      await alert(env, "Milestones: OAuth-токен отклонён (401)");
      continue;
    }
    result.requested.push({ bid_id: bidId, project_id: projectId, amount, error: `HTTP ${res.status}: ${text}` });
  }

  return result;
}
