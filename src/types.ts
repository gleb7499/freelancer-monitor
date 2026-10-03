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
  owner_id: number | null;
  owner?: OwnerInfo | null;
  description: string;
  language: string;
  submit_ts: number;
  deadline_hint: string | null;
  competition: "normal" | "high" | null;
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
  source?: "alert" | "search";
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
  value_score: number;
  ai_hours: number;
}

export type UpgradeId = "sealed" | "highlight" | "sponsored";

// Информация о заказчике (enrich.fetchOwnerInfo). Анонимный эндпоинт
// users/0.1 не отдаёт payment_verified и открытые заказы — только OAuth.
export interface OwnerInfo {
  id: number;
  username: string | null;
  reputation_overall: number | null;
  reviews: number | null;
  completion_rate: number | null;
  rehire_rate: number | null;
  employer_overall: number | null;
  employer_complete: number | null;
  employer_rehire_rate: number | null;
  payment_verified: null;
  open_projects: null;
}

export interface Env {
  ORDERS_KV: KVNamespace;
  DB: D1Database;
  KIMI_API_KEY: string;
  KIMI_API_BASE: string;
  KIMI_MODEL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ADMIN_TOKEN: string;
  FREELANCER_API_BASE: string;
  DEFAULT_WEEKLY_LIMIT: string;
  FL_USER_ID: string;
  FL_AUTH_HASH: string;
  FL_OAUTH_TOKEN: string;
  TARGET_HOURLY: string;
  BID_MIN_SCORE: string;
}
