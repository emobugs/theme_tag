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

export const TIMEZONE = 'Europe/Sofia';
