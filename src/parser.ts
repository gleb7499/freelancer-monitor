import type { Order } from "./types";

const MAX_DESCRIPTION_LENGTH = 4000;

interface FreelancerProject {
  id: number;
  title?: string;
  type?: string;
  seo_url?: string;
  owner_id?: number;
  description?: string;
  preview_description?: string;
  submitdate?: number;
  bidperiod?: number;
  budget?: {
    minimum?: number;
    maximum?: number;
    currency?: { code?: string; sign?: string; exchange_rate?: number };
  };
  // В compact-ответах валюта с exchange_rate лежит в корне проекта,
  // а budget.currency отсутствует.
  currency?: { code?: string; sign?: string; exchange_rate?: number };
  bid_stats?: { bid_count?: number; bid_avg?: number };
  upgrades?: Record<string, unknown>;
  active_prepaid_milestone?: unknown;
  language?: string;
  hidebids?: boolean;
  is_escrow_project?: boolean;
  time_free_bids_expire?: number;
  is_seller_kyc_required?: boolean;
}

function usdAmount(value: number | undefined, exchangeRate: number): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.round(raw * exchangeRate * 100) / 100;
}

function originalAmount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeProject(project: FreelancerProject, nicheId: string): Order {
  const currency = project.budget?.currency ?? project.currency;
  const exchangeRate =
    currency && currency.code !== "USD" && typeof currency.exchange_rate === "number"
      ? currency.exchange_rate
      : 1;

  const upgrades = project.upgrades ?? {};
  const bool = (key: string): boolean => upgrades[key] === true;

  const description =
    (project.description ?? project.preview_description ?? "").slice(0, MAX_DESCRIPTION_LENGTH);

  const budgetMin = originalAmount(project.budget?.minimum);
  // У части заказов (чаще hourly) API отдаёт budget.maximum = 0 — считаем max = min.
  const budgetMaxRaw = originalAmount(project.budget?.maximum);
  const budgetMax = budgetMaxRaw > 0 ? budgetMaxRaw : budgetMin;

  return {
    platform: "freelancer",
    niche_id: nicheId,
    id: project.id,
    title: project.title ?? "",
    url: `https://www.freelancer.com/projects/${project.seo_url ?? ""}`,
    type: project.type === "hourly" ? "hourly" : "fixed",
    budget_min: usdAmount(project.budget?.minimum, exchangeRate),
    budget_max: usdAmount(budgetMax, exchangeRate),
    budget_min_original: budgetMin,
    budget_max_original: budgetMax,
    currency_code: currency?.code ?? "USD",
    currency_sign: currency?.sign ?? "$",
    bids: project.bid_stats?.bid_count ?? 0,
    bid_avg:
      typeof project.bid_stats?.bid_avg === "number"
        ? usdAmount(project.bid_stats.bid_avg, exchangeRate)
        : null,
    owner_id: typeof project.owner_id === "number" ? project.owner_id : null,
    description,
    language: project.language ?? "en",
    submit_ts: project.submitdate ?? 0,
    deadline_hint: typeof project.bidperiod === "number" ? `bidperiod ${project.bidperiod}d` : null,
    competition: null,
    hidebids: project.hidebids === true,
    is_escrow_project: project.is_escrow_project === true,
    time_free_bids_expire:
      typeof project.time_free_bids_expire === "number"
        ? project.time_free_bids_expire
        : null,
    is_seller_kyc_required: project.is_seller_kyc_required === true,
    upgrades: {
      fulltime: bool("fulltime"),
      featured: bool("featured"),
      sealed: bool("sealed"),
      NDA: bool("NDA"),
      urgent: bool("urgent"),
      recruiter: bool("recruiter"),
    },
    prepaid_milestone: !!project.active_prepaid_milestone,
    source: "alert",
  };
}
