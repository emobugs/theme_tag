import { TEAMS, TIMEZONE, type TeamId } from './config';
import type { FameRow, GifterRow, LiveEvent, RoundEndReason, StatsSnapshot, Viewer } from './events';

// Room държи кой зрител в кой отбор е и класациите. Работи еднакво в bridge-а (Node)
// и в офлайн режима на overlay-а (браузър). Persistence се подава отвън.

export interface PersistedState {
  version: 1;
  members: Record<string, TeamId>;
  day: { date: string; wins: Record<TeamId, number>; gifters: Record<string, GifterRow> };
  allTimeWins: Record<TeamId, number>;
  fame: FameRow[];
  rounds: number;
}

const MAX_MEMBERS = 50_000;
const MAX_DAY_GIFTERS = 2_000;
const MAX_FAME = 20;

export function todayKey(now = new Date()): string {
  // sv-SE дава формат YYYY-MM-DD
  return now.toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}

function zeroTeams(): Record<TeamId, number> {
  return Object.fromEntries(TEAMS.map((t) => [t.id, 0])) as Record<TeamId, number>;
}

export function emptyState(): PersistedState {
  return {
    version: 1,
    members: {},
    day: { date: todayKey(), wins: zeroTeams(), gifters: {} },
    allTimeWins: zeroTeams(),
    fame: [],
    rounds: 0,
  };
}

// Намира първия отбор, споменат в коментара (емоджи или дума).
export function detectTeam(text: string): TeamId | null {
  const lower = text.toLowerCase();
  let best: { id: TeamId; pos: number } | null = null;
  for (const t of TEAMS) {
    const needles: string[] = [t.emoji, ...t.aliases];
    for (const n of needles) {
      const pos = lower.indexOf(n);
      if (pos === -1) continue;
      // думите трябва да са самостоятелни, иначе "огънче" също ще мине (ок), но "pigeon" не трябва
      if (!/\p{Extended_Pictographic}/u.test(n)) {
        const after = lower.charAt(pos + n.length);
        if (after && /[\p{L}\p{N}]/u.test(after) && !/[а-я]/.test(after)) continue;
      }
      if (!best || pos < best.pos) best = { id: t.id, pos };
    }
  }
  return best?.id ?? null;
}

export class Room {
  state: PersistedState;
  private roundGifters = new Map<string, GifterRow>();
  private roundCoins = zeroTeams();
  private teamCounts = zeroTeams();
  private onChange: () => void;

  constructor(state?: PersistedState, onChange: () => void = () => {}) {
    this.state = state && state.version === 1 ? state : emptyState();
    // попълва липсващи отбори, ако някой е добавен в config
    for (const t of TEAMS) {
      this.state.day.wins[t.id] ??= 0;
      this.state.allTimeWins[t.id] ??= 0;
    }
    for (const team of Object.values(this.state.members)) {
      if (team in this.teamCounts) this.teamCounts[team]++;
    }
    this.onChange = onChange;
  }

  private rollDay() {
    const key = todayKey();
    if (this.state.day.date !== key) {
      this.state.day = { date: key, wins: zeroTeams(), gifters: {} };
    }
  }

  teamOf(userId: string): TeamId | null {
    const team = this.state.members[userId];
    return team && team in this.teamCounts ? team : null;
  }

  private smallestTeam(): TeamId {
    let best: TeamId = TEAMS[0].id;
    let min = Infinity;
    // лек random при равенство, за да не пълним винаги първия отбор
    const order = [...TEAMS].sort(() => Math.random() - 0.5);
    for (const t of order) {
      if (this.teamCounts[t.id] < min) {
        min = this.teamCounts[t.id];
        best = t.id;
      }
    }
    return best;
  }

  private setTeam(userId: string, team: TeamId) {
    const prev = this.teamOf(userId);
    if (prev) this.teamCounts[prev]--;
    this.state.members[userId] = team;
    this.teamCounts[team]++;
    const ids = Object.keys(this.state.members);
    if (ids.length > MAX_MEMBERS) {
      // трие най-старите записи (обектите пазят реда на вмъкване)
      for (const id of ids.slice(0, ids.length - MAX_MEMBERS)) {
        const t = this.state.members[id];
        if (t in this.teamCounts) this.teamCounts[t]--;
        delete this.state.members[id];
      }
    }
  }

  chat(user: Viewer, text: string): LiveEvent[] {
    const team = detectTeam(text);
    if (!team) return [];
    const prev = this.teamOf(user.id);
    if (prev === team) return [];
    this.setTeam(user.id, team);
    this.onChange();
    return [{ kind: 'join', user, team, switched: prev !== null }];
  }

  gift(user: Viewer, coins: number, count: number, giftName: string, giftImage?: string, forceTeam?: TeamId): LiveEvent[] {
    this.rollDay();
    const out: LiveEvent[] = [];
    let team = forceTeam ?? this.teamOf(user.id);
    if (forceTeam && this.teamOf(user.id) !== forceTeam) {
      this.setTeam(user.id, forceTeam);
    }
    if (!team) {
      team = this.smallestTeam();
      this.setTeam(user.id, team);
      out.push({ kind: 'join', user, team, switched: false });
    }
    const total = coins * count;
    this.roundCoins[team] += total;
    const bump = (map: Map<string, GifterRow> | Record<string, GifterRow>) => {
      const get = (id: string) => (map instanceof Map ? map.get(id) : map[id]);
      const row = get(user.id) ?? { id: user.id, name: user.name, avatar: user.avatar, team, coins: 0 };
      row.coins += total;
      row.team = team!;
      row.name = user.name;
      if (user.avatar) row.avatar = user.avatar;
      if (map instanceof Map) map.set(user.id, row);
      else map[user.id] = row;
    };
    bump(this.roundGifters);
    bump(this.state.day.gifters);
    this.pruneDayGifters();
    out.push({ kind: 'gift', user, team, coins, count, giftName, giftImage });
    this.onChange();
    return out;
  }

  private pruneDayGifters() {
    const g = this.state.day.gifters;
    const ids = Object.keys(g);
    if (ids.length <= MAX_DAY_GIFTERS) return;
    const keep = ids.sort((a, b) => g[b].coins - g[a].coins).slice(0, MAX_DAY_GIFTERS / 2);
    const next: Record<string, GifterRow> = {};
    for (const id of keep) next[id] = g[id];
    this.state.day.gifters = next;
  }

  like(user: Viewer, count: number): LiveEvent[] {
    return [{ kind: 'like', user, team: this.teamOf(user.id), count }];
  }

  share(user: Viewer): LiveEvent[] {
    return [{ kind: 'share', user, team: this.teamOf(user.id) }];
  }

  follow(user: Viewer): LiveEvent[] {
    return [{ kind: 'follow', user, team: this.teamOf(user.id) }];
  }

  roundStart() {
    this.roundGifters.clear();
    this.roundCoins = zeroTeams();
    this.onChange();
  }

  roundEnd(winner: TeamId | null, reason: RoundEndReason, by?: { name: string; coins: number }) {
    this.rollDay();
    this.state.rounds++;
    if (winner && winner in this.teamCounts) {
      this.state.day.wins[winner]++;
      this.state.allTimeWins[winner]++;
      if (reason === 'crown' && by) {
        this.state.fame.unshift({ name: by.name, team: winner, coins: by.coins, at: Date.now() });
        this.state.fame = this.state.fame.slice(0, MAX_FAME);
      }
    }
    this.onChange();
  }

  snapshot(): StatsSnapshot {
    this.rollDay();
    const top = (rows: GifterRow[], n: number) => [...rows].sort((a, b) => b.coins - a.coins).slice(0, n);
    return {
      date: this.state.day.date,
      members: { ...this.teamCounts },
      roundCoins: { ...this.roundCoins },
      roundTop: top([...this.roundGifters.values()], 5),
      todayTop: top(Object.values(this.state.day.gifters), 5),
      todayWins: { ...this.state.day.wins },
      allTimeWins: { ...this.state.allTimeWins },
      fame: this.state.fame.slice(0, 5),
      rounds: this.state.rounds,
    };
  }
}
