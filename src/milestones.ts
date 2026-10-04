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
const KV_REQ_TTL = 30 * 86400;
const SMALL_BID_USD = 100;
const KICKOFF_RATIO = 0.3;

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

    // Дедуп: запрос на эту ставку уже создавали.
    const dedupKey = `${KV_REQ_PREFIX}${bidId}`;
    const existing = await env.ORDERS_KV.get(dedupKey);
    if (existing !== null) {
      result.skipped.push({ bid_id: bidId, reason: "already-requested" });
      continue;
    }

    // Малый заказ (в долларовом эквиваленте) этапить не надо. Ошибка fetch
    // проекта не блокирует: консервативно считаем заказ крупным.
    let order: Order | undefined;
    try {
      order = (await fetchProjectsByIds(env, [projectId]))[0];
    } catch (e) {
      console.warn("milestones.project-fetch-failed", { project_id: projectId, err: String(e) });
    }
    if (order) {
      const rate =
        order.budget_min > 0 && order.budget_min_original > 0
          ? order.budget_min_original / order.budget_min
          : 1;
      const bidUsd = bidAmount / rate;
      if (bidUsd < SMALL_BID_USD) {
        result.skipped.push({ bid_id: bidId, reason: "small-bid" });
        continue;
      }
    }

    const amount = Math.round(bidAmount * KICKOFF_RATIO * 100) / 100;
    if (!(amount > 0)) {
      result.skipped.push({ bid_id: bidId, reason: "zero-amount" });
      continue;
    }

    if (dryRun) {
      result.requested.push({ bid_id: bidId, project_id: projectId, amount });
      continue;
    }

    const description = "Kickoff milestone - 30% upfront to start work; the remainder on delivery.";
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
      await env.ORDERS_KV.put(
        dedupKey,
        JSON.stringify({ request_id: requestId ?? null, amount, ts: Date.now() }),
        { expirationTtl: KV_REQ_TTL },
      );
      result.requested.push({ bid_id: bidId, project_id: projectId, amount, request_id: requestId });
      const sign = order?.currency_sign ?? "$";
      const projectPart = order ? order.url : `project #${projectId}`;
      await sendTelegram(
        env,
        `💰 Запрошен этап оплаты\n\nПроект: ${projectPart}\nЭтап: ${sign}${amount} (30% от ставки ${sign}${bidAmount})\nЗапрос #${requestId ?? "?"} — ждёт принятия работодателем.`,
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
