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
  client?: ProjectClientInfo | null;
  description: string;
  language: string;
  submit_ts: number;
  deadline_hint: string | null;
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
  source?: "active";
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

// Информация о заказчике (enrich.fetchProjectClient). Источник — открытый
// эндпоинт projects/0.1/projects/seo (проверено live 2026-10-04): verification,
// рейтинг работодателя, registration_unixtime, other_employer_jobs.
export interface ProjectClientInfo {
  payment_verified: boolean | null;
  deposit_made: boolean | null;
  email_verified: boolean | null;
  phone_verified: boolean | null;
  rating: number | null;
  review_count: number | null;
  registered_ts: number | null;
  country: string | null;
  open_projects: number | null;
  // Скиллы проекта из того же ответа projects/seo (id-шники) — используются
  // пре-гейтом до LLM (крипто-скилл = верификация аккаунта обязательна).
  skill_ids: number[] | null;
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
  TICK_SCHEDULER: DurableObjectNamespace;
  FREELANCER_API_BASE: string;
  DEFAULT_WEEKLY_LIMIT: string;
  FL_USER_ID: string;
  FL_AUTH_HASH: string;
  FL_OAUTH_TOKEN: string;
  // Ключ Develop API (закрытые точки, авторизация Authorization: Bearer).
  // Фолбэк, когда OAuth-токена нет (например, локальный wrangler dev).
  FL_API_KEY?: string;
  TARGET_HOURLY: string;
  BID_MIN_SCORE: string;
}
