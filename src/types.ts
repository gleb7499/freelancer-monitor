export interface Order {
  platform: "freelancer";
  niche_id: string;
  id: number;
  title: string;
  url: string;
  type: "fixed" | "hourly";
  budget_min: number;
  budget_max: number;
  budget_min_original: number;
  budget_max_original: number;
  currency_code: string;
  currency_sign: string;
  bids: number;
  bid_avg: number | null;
  description: string;
  language: string;
  submit_ts: number;
  deadline_hint: string | null;
  competition: "normal" | "high" | "extreme" | null;
  hidebids: boolean;
  is_escrow_project: boolean;
  time_free_bids_expire: number | null;
  is_seller_kyc_required: boolean;
  upgrades: {
    fulltime: boolean;
    featured: boolean;
    sealed: boolean;
    NDA: boolean;
    urgent: boolean;
    recruiter: boolean;
  };
  prepaid_milestone: boolean;
}

export interface Hours {
  opt: number;
  real: number;
  pess: number;
}

export interface ScoreResult {
  verdict: "BID" | "PASS";
  reason: string;
  summary_ru: string;
  hours: Hours;
  red_flags: string[];
  check_manually: string[];
  bid_amount: number;
  net_amount: number;
  weekly_limit_hours: number | null;
  delivery_days: number;
  deadline_caveat: string | null;
  take_upgrades: UpgradeId[];
}

export type UpgradeId = "sealed" | "highlight" | "sponsored";

export interface Env {
  ORDERS_KV: KVNamespace;
  KIMI_API_KEY: string;
  KIMI_API_BASE: string;
  KIMI_MODEL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ADMIN_TOKEN: string;
  FREELANCER_API_BASE: string;
  MAX_BIDS: string;
  DEFAULT_WEEKLY_LIMIT: string;
  MAX_CARDS_PER_HOUR: string;
  NICHES_PER_TICK: string;
}

export interface Niche {
  id: string;
  name: string;
  queries: string[];
  jobs: number[];
}
