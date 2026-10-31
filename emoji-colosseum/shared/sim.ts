import { TEAMS, type TeamId } from './config';

// Симулатор на зрители. Ползва се от bridge-а (--sim) и от overlay-а (?offline=1),
// за да видиш играта без да си на живо.

const FIRST = [
  'Иван', 'Мария', 'Гошо', 'Ели', 'Пешо', 'Ники', 'Деси', 'Краси', 'Вики', 'Тони',
  'Стефи', 'Цвети', 'Митко', 'Габи', 'Ради', 'Любо', 'Жоро', 'Кали', 'Боби', 'Яна',
];
const SUFFIX = ['', '_bg', '99', '_silistra', '.official', '_x', '2007', '_varna', '_sofia', '777'];

const GIFTS: { name: string; coins: number; weight: number; streak: boolean }[] = [
  { name: 'Роза', coins: 1, weight: 40, streak: true },
  { name: 'TikTok', coins: 1, weight: 15, streak: true },
  { name: 'Finger Heart', coins: 5, weight: 18, streak: true },
  { name: 'Rosa', coins: 10, weight: 8, streak: true },
  { name: 'Perfume', coins: 20, weight: 6, streak: false },
  { name: 'Doughnut', coins: 30, weight: 5, streak: false },
  { name: 'Hand Hearts', coins: 100, weight: 3.5, streak: false },
  { name: 'Corgi', coins: 299, weight: 1.6, streak: false },
  { name: 'Money Gun', coins: 500, weight: 1.2, streak: false },
  { name: 'Galaxy', coins: 1000, weight: 0.35, streak: false },
  { name: 'Lion', coins: 29999, weight: 0.02, streak: false },
];

export interface SimSink {
  chat(user: { id: string; name: string }, text: string): void;
  gift(user: { id: string; name: string }, coins: number, count: number, giftName: string): void;
  like(user: { id: string; name: string }, count: number): void;
  share(user: { id: string; name: string }): void;
  follow(user: { id: string; name: string }): void;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function weighted<T extends { weight: number }>(arr: T[]): T {
  const total = arr.reduce((s, a) => s + a.weight, 0);
  let r = Math.random() * total;
  for (const a of arr) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return arr[arr.length - 1];
}

export class Simulator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private viewers: { id: string; name: string; team?: TeamId }[] = [];
  // intensity: 1 = оживен лайф, 0.3 = тих
  constructor(private sink: SimSink, private intensity = 1) {
    for (let i = 0; i < 60; i++) {
      const name = pick(FIRST) + pick(SUFFIX);
      this.viewers.push({ id: `sim_${i}_${name}`, name });
    }
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer) return;
    const loop = () => {
      this.tick();
      this.timer = setTimeout(loop, (300 + Math.random() * 900) / this.intensity);
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  tick() {
    const viewer = pick(this.viewers);
    const v = { id: viewer.id, name: viewer.name };
    const r = Math.random();
    if (!viewer.team || r < 0.18) {
      const t = pick(TEAMS);
      viewer.team = t.id;
      const lines = [t.emoji, `${t.emoji}${t.emoji}${t.emoji}`, `давай ${t.emoji}`, `${t.emoji} е най-добрият`, t.aliases[0]];
      this.sink.chat(v, pick(lines));
      return;
    }
    if (r < 0.55) {
      this.sink.like(v, 1 + Math.floor(Math.random() * 15));
      return;
    }
    if (r < 0.6) {
      this.sink.share(v);
      return;
    }
    if (r < 0.62) {
      this.sink.follow(v);
      return;
    }
    if (r < 0.92) {
      const g = weighted(GIFTS);
      const count = g.streak ? 1 + Math.floor(Math.random() ** 3 * 25) : 1;
      this.sink.gift(v, g.coins, count, g.name);
      return;
    }
    this.sink.chat(v, pick(['хаха', 'кой води?', 'еееее', 'бомба!!!', 'хайде де']));
  }
}
