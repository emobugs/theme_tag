// Единственото място, където се настройва играта. Промени тук, рестартирай, готово.

export const TEAMS = [
  { id: 'fire', emoji: '🔥', name: 'Огън', color: '#ff7a2f', aliases: ['огън', 'fire'] },
  { id: 'lol', emoji: '😂', name: 'Смях', color: '#ffd23f', aliases: ['смях', 'lol'] },
  { id: 'skull', emoji: '💀', name: 'Череп', color: '#e6e6f0', aliases: ['череп', 'skull'] },
  { id: 'frog', emoji: '🐸', name: 'Жаба', color: '#58d858', aliases: ['жаба', 'frog'] },
  { id: 'alien', emoji: '👽', name: 'Извънземно', color: '#6ff0c0', aliases: ['извънземно', 'alien'] },
  { id: 'clown', emoji: '🤡', name: 'Клоун', color: '#ff4d6d', aliases: ['клоун', 'clown'] },
  { id: 'unicorn', emoji: '🦄', name: 'Еднорог', color: '#c77dff', aliases: ['еднорог', 'unicorn'] },
  { id: 'pig', emoji: '🐷', name: 'Прасе', color: '#ff9ecd', aliases: ['прасе', 'pig'] },
] as const;

export type TeamDef = (typeof TEAMS)[number];
export type TeamId = TeamDef['id'];

export const TEAM_BY_ID: Record<TeamId, TeamDef> = Object.fromEntries(
  TEAMS.map((t) => [t.id, t]),
) as Record<TeamId, TeamDef>;

export type TierAction = 'grow' | 'dash' | 'minions' | 'shield' | 'bomb' | 'meteor' | 'crown';

export interface Tier {
  min: number; // монети за ЕДИН подарък (включително)
  action: TierAction;
  label: string;
  icon: string;
}

// Сортирани възходящо. Нивото се определя по стойността на един подарък,
// а при серия (streak) ефектът се повтаря толкова пъти, колкото е серията.
export const TIERS: Tier[] = [
  { min: 1, action: 'grow', label: 'Расте', icon: '🌹' },
  { min: 5, action: 'dash', label: 'Ускорение', icon: '⚡' },
  { min: 20, action: 'minions', label: '3 миньона', icon: '🐣' },
  { min: 100, action: 'shield', label: 'Щит 15с', icon: '🛡️' },
  { min: 300, action: 'bomb', label: 'Бомба по лидера', icon: '💣' },
  { min: 1000, action: 'meteor', label: 'Метеор', icon: '☄️' },
  { min: 10000, action: 'crown', label: 'Краде короната', icon: '👑' },
];

export function tierFor(coins: number): Tier {
  let found = TIERS[0];
  for (const t of TIERS) if (coins >= t.min) found = t;
  return found;
}

export const GAME = {
  // Сцена (вертикален TikTok кадър)
  stageW: 1080,
  stageH: 1920,
  arena: { x: 90, y: 480, size: 900 },

  // Рунд
  countdownSec: 4,
  roundSec: 240,
  rageSec: 60, // последните N секунди щетите са x2
  endSec: 10,

  // Шампиони
  baseRadius: 58,
  maxRadius: 130,
  growFactor: 1.035,
  baseHp: 100,
  regenPerSec: 0.35,
  impulseSpeed: [6, 9] as [number, number], // px на стъпка
  thinkEveryMs: [700, 1500] as [number, number],

  // Щети
  hitDamage: 0.06, // множител на относителната скорост
  minImpact: 2.5,
  rageMultiplier: 2.5,

  // Ефекти от подаръци
  dashMs: 3000,
  dashDamage: 1.8,
  shieldMs: 15000,
  minionsPerGift: 3,
  maxMinionsPerTeam: 15,
  minionTtlMs: 22000,
  minionDamage: 5,
  bombDamage: 0.35, // дял от maxHp
  bombSplash: 0.15,
  bombRadius: 230,
  meteorDamage: 0.55,
  reviveHp: 0.35,

  // Лайкове, споделяния, последвания
  likeHeal: 0.12, // HP за един лайк
  shareHeal: 0.1, // дял от maxHp
  followMinions: 1,

  // Лимит, за да не умре играта при серия от 999 рози
  maxRepeatPerEvent: 60,
};

export const BRIDGE = {
  defaultPort: 8787,
};

export type Platform = 'tiktok' | 'twitch' | 'youtube';

// Как се превръщат плащанията от другите платформи в "монети" (1 монета ≈ 1 цент).
// Така таблицата TIERS важи навсякъде.
export const PLATFORMS = {
  twitch: {
    // 1 Bit ≈ 1 цент, затова Bits = монети 1:1
    bitsToCoins: 1,
    // абонамент по ниво (Prime се брои като Tier 1)
    subCoins: { Prime: 500, '1000': 500, '2000': 1000, '3000': 2500 } as Record<string, number>,
    raidCoins: 300, // рейд = бомба
    // всяко съобщение в чата лекува отбора като лайкове (Twitch няма лайкове)
    chatLikes: 3,
  },
  youtube: {
    coinsPerUsd: 100, // Super Chat $1 = 100 монети = щит, $3 = бомба, $10 = метеор, $100 = корона
    memberCoins: 500, // ново членство или подарено членство = бомба
    chatLikes: 3,
    minPollMs: 1500,
    maxPollMs: 6000,
  },
};

// Приблизителни курсове към долар. Само за превръщане на Super Chat в монети, не за счетоводство.
export const USD_RATES: Record<string, number> = {
  USD: 1, EUR: 1.08, BGN: 0.55, GBP: 1.27, CHF: 1.12, PLN: 0.25, RON: 0.22, CZK: 0.043, HUF: 0.0027,
  SEK: 0.095, NOK: 0.093, DKK: 0.145, TRY: 0.029, RSD: 0.0092, UAH: 0.024, RUB: 0.011,
  CAD: 0.73, AUD: 0.66, NZD: 0.6, MXN: 0.055, BRL: 0.18, ARS: 0.001, CLP: 0.0011, COP: 0.00025,
  JPY: 0.0067, KRW: 0.00073, INR: 0.012, IDR: 0.000062, PHP: 0.017, THB: 0.028, VND: 0.00004,
  HKD: 0.128, TWD: 0.031, SGD: 0.74, MYR: 0.22, ILS: 0.27, AED: 0.27, SAR: 0.27, ZAR: 0.054,
};

export const TIMEZONE = 'Europe/Sofia';
