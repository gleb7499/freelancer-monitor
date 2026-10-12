import type { Env } from "./types";

// Реестр каналов откликов. Канал — свой поиск заказов (kind "search") под
// конкретный профиль аккаунта, либо общая лента (kind "shared", channel=null
// у заказа — профиль тогда выбирает LLM при скоринге).

export interface SearchSpec {
  skills: number[];
  languages: string[];
  projectTypes: ("hourly" | "fixed")[];
}

export type ChannelId = "feed" | "main" | "android";
export type ProfileId = "main" | "android";

export interface Channel {
  id: ChannelId;
  kind: "shared" | "search";
  label: string;
  // Имя профиля Freelancer (null у feed).
  profileName: string | null;
  // Числовой id профиля Freelancer (null у feed).
  profileIdHint: number | null;
  searches: SearchSpec[];
  // Пусто — без фильтра портфолио.
  portfolioItemIds: number[];
  enabled: boolean;
  isDefault: boolean;
}

const MAIN_SKILLS = [9, 323, 607, 741, 759, 979, 1002, 1042, 2370, 2376, 2703];

// Статический реестр (enabled для android здесь false — включение решает env
// в getChannels; см. buildScoringSystemPrompt, которому нужен актуальный список).
const REGISTRY: Channel[] = [
  {
    id: "feed",
    kind: "shared",
    label: "Feed",
    profileName: null,
    profileIdHint: null,
    searches: [],
    portfolioItemIds: [],
    enabled: true,
    isDefault: false,
  },
  {
    id: "main",
    kind: "search",
    label: "General",
    profileName: "General",
    profileIdHint: 31216034,
    searches: [
      { skills: MAIN_SKILLS, languages: ["en"], projectTypes: ["hourly", "fixed"] },
    ],
    portfolioItemIds: [],
    enabled: true,
    isDefault: true,
  },
  {
    id: "android",
    kind: "search",
    label: "Android Development",
    profileName: "Android Development",
    profileIdHint: 35766270,
    // TODO(android): впишать скиллы Android-канала при его включении
    // (CHANNEL_ANDROID_ENABLED=1) — searches сейчас пусто, поиск не запускается.
    searches: [],
    portfolioItemIds: [],
    enabled: false,
    isDefault: false,
  },
];

export function getChannels(env: Pick<Env, "CHANNEL_ANDROID_ENABLED">): Channel[] {
  return REGISTRY.map((ch) =>
    ch.id === "android" ? { ...ch, enabled: env.CHANNEL_ANDROID_ENABLED === "1" } : ch,
  );
}

export function channelById(id: ChannelId): Channel {
  const ch = REGISTRY.find((c) => c.id === id);
  if (!ch) throw new Error(`unknown channel: ${id}`);
  return ch;
}

export function profileChannel(profile: ProfileId): Channel {
  return channelById(profile);
}

export type PortfolioItemLike = { id: number };

export function filterPortfolioByChannel<T extends PortfolioItemLike>(
  items: T[],
  ch: Channel,
): T[] {
  if (ch.portfolioItemIds.length === 0) return items;
  const ids = new Set(ch.portfolioItemIds);
  return items.filter((it) => ids.has(it.id));
}

// Профили, по которым сейчас можно откликаться — блок профилей в промпте
// скоринга и fallback-профиль для заказов из общего feed.
export function ENABLED_PROFILES(env: Pick<Env, "CHANNEL_ANDROID_ENABLED">): Channel[] {
  return getChannels(env).filter((ch) => ch.kind === "search" && ch.enabled);
}
