import type { Env, Niche, Order } from "./types";
import { getConfig } from "./config";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15000;
const QUERY_DELAY_MS = 1000;
const MAX_DESCRIPTION_LENGTH = 4000;

export class ParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParserError";
  }
}

interface FreelancerProject {
  id: number;
  title?: string;
  type?: string;
  seo_url?: string;
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

interface FreelancerResponse {
  status?: string;
  result?: {
    projects?: FreelancerProject[];
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usdAmount(value: number | undefined, exchangeRate: number): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.round(raw * exchangeRate * 100) / 100;
}

function originalAmount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeProject(project: FreelancerProject, nicheId: string): Order {
  const currency = project.budget?.currency ?? project.currency;
  const exchangeRate =
    currency && currency.code !== "USD" && typeof currency.exchange_rate === "number"
      ? currency.exchange_rate
      : 1;

  const upgrades = project.upgrades ?? {};
  const bool = (key: string): boolean => upgrades[key] === true;

  const description =
    (project.description ?? project.preview_description ?? "").slice(0, MAX_DESCRIPTION_LENGTH);

  return {
    platform: "freelancer",
    niche_id: nicheId,
    id: project.id,
    title: project.title ?? "",
    url: `https://www.freelancer.com/projects/${project.seo_url ?? ""}`,
    type: project.type === "hourly" ? "hourly" : "fixed",
    budget_min: usdAmount(project.budget?.minimum, exchangeRate),
    budget_max: usdAmount(project.budget?.maximum, exchangeRate),
    budget_min_original: originalAmount(project.budget?.minimum),
    budget_max_original: originalAmount(project.budget?.maximum),
    currency_code: currency?.code ?? "USD",
    currency_sign: currency?.sign ?? "$",
    bids: project.bid_stats?.bid_count ?? 0,
    bid_avg:
      typeof project.bid_stats?.bid_avg === "number"
        ? usdAmount(project.bid_stats.bid_avg, exchangeRate)
        : null,
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
  };
}

async function fetchQuery(
  env: Env,
  niche: Niche,
  query: string
): Promise<Order[]> {
  const config = getConfig(env);
  const url = new URL(`${config.freelancerBase}/projects/active/`);
  url.searchParams.set("query", query);
  for (const job of niche.jobs) url.searchParams.append("jobs[]", String(job));
  url.searchParams.append("project_types[]", "fixed");
  url.searchParams.append("project_types[]", "hourly");
  url.searchParams.append("languages[]", "en");
  url.searchParams.set("sort_field", "submitdate");
  url.searchParams.set("limit", "50");
  url.searchParams.set("full_description", "true");
  url.searchParams.set("compact", "true");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ParserError(`fetch failed for niche ${niche.id}: ${String(error)}`);
  }

  if (!response.ok) {
    throw new ParserError(`HTTP ${response.status} for niche ${niche.id}`);
  }

  let data: FreelancerResponse;
  try {
    data = (await response.json()) as FreelancerResponse;
  } catch (error) {
    throw new ParserError(`invalid JSON for niche ${niche.id}: ${String(error)}`);
  }

  if (data.status !== "success" || !data.result) {
    throw new ParserError(`API status not success for niche ${niche.id}`);
  }

  return (data.result.projects ?? []).map((project) =>
    normalizeProject(project, niche.id)
  );
}

export async function fetchNicheOrders(env: Env, niche: Niche): Promise<Order[]> {
  const byId = new Map<number, Order>();

  for (let i = 0; i < niche.queries.length; i++) {
    const orders = await fetchQuery(env, niche, niche.queries[i]);
    for (const order of orders) {
      if (!byId.has(order.id)) byId.set(order.id, order);
    }
    if (i < niche.queries.length - 1) await sleep(QUERY_DELAY_MS);
  }

  return [...byId.values()];
}

export async function fetchAllNiches(
  env: Env,
  niches: Niche[]
): Promise<{ orders: Order[]; errors: string[]; perNiche: Record<string, number> }> {
  const byId = new Map<number, Order>();
  const errors: string[] = [];
  const perNiche: Record<string, number> = {};

  for (const niche of niches) {
    try {
      const orders = await fetchNicheOrders(env, niche);
      perNiche[niche.id] = orders.length;
      for (const order of orders) {
        if (!byId.has(order.id)) byId.set(order.id, order);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { orders: [...byId.values()], errors, perNiche };
}
