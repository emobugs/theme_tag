import Matter from 'matter-js';
import { GAME, TEAMS, TEAM_BY_ID, TIERS, tierFor, type TeamDef, type TeamId } from '../shared/config';
import type { LiveEvent, RoundEndReason } from '../shared/events';

// Чиста игрова логика без DOM. Върти се в браузъра, а scripts/tune.ts я пуска headless,
// за да се балансира колко трае един рунд без подаръци.

const { Engine, Bodies, Body, Composite, Events } = Matter;

export type Phase = 'countdown' | 'fight' | 'end';
export type SfxName = 'hit' | 'pop' | 'grow' | 'dash' | 'shield' | 'bomb' | 'meteor' | 'crown' | 'ko' | 'revive' | 'start' | 'win' | 'tick';

export type Notice =
  | { type: 'toast'; text: string; team?: TeamId; level: 0 | 1 | 2 }
  | { type: 'banner'; title: string; sub?: string; team?: TeamId; big?: boolean }
  | { type: 'sfx'; name: SfxName }
  | { type: 'shake'; power: number }
  | { type: 'say'; text: string }
  | { type: 'roundStart'; roundId: string; round: number }
  | { type: 'roundEnd'; roundId: string; winner: TeamId | null; reason: RoundEndReason; by?: { name: string; coins: number } };

export interface Champion {
  kind: 'champ';
  team: TeamDef;
  body: Matter.Body;
  radius: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  shieldUntil: number;
  dashUntil: number;
  nextThink: number;
  flash: number;
  lastHitBy: TeamId | null;
  lastHitAt: number;
  trail: { x: number; y: number }[];
}

export interface Minion {
  kind: 'minion';
  team: TeamDef;
  body: Matter.Body;
  radius: number;
  bornAt: number;
  dead: boolean;
  nextThink: number;
}

type Entity = Champion | Minion;

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  text?: string;
  emoji?: string;
  drag?: number;
}

export interface Projectile {
  kind: 'bomb' | 'meteor';
  team: TeamId;
  fromX: number;
  fromY: number;
  x: number;
  y: number;
  target: Champion;
  start: number;
  dur: number;
  onHit: () => void;
}

export interface TeamHud {
  id: TeamId;
  emoji: string;
  name: string;
  color: string;
  hp: number;
  maxHp: number;
  alive: boolean;
  shield: boolean;
  dash: boolean;
  minions: number;
}

export interface HudState {
  phase: Phase;
  round: number;
  timeLeft: number;
  rage: boolean;
  winner: TeamId | null;
  teams: TeamHud[];
}

const STEP = 1000 / 60;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Game {
  readonly size = GAME.arena.size;
  engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
  champions: Champion[] = [];
  minions: Minion[] = [];
  particles: Particle[] = [];
  projectiles: Projectile[] = [];
  phase: Phase = 'countdown';
  phaseEnd = 0;
  round = 0;
  roundId = '';
  winner: TeamId | null = null;
  now = 0;
  /** true за headless тестове: без частици */
  lite = false;

  private acc = 0;
  private byBody = new Map<number, Entity>();
  private timers: { at: number; fn: () => void }[] = [];
  private pending: LiveEvent[] = [];
  private lastCountdown = -1;
  private lastHeart = new Map<TeamId, number>();
  private notices: Notice[] = [];

  constructor(private notify: (n: Notice) => void = () => {}) {
    const s = this.size;
    const t = 400;
    const wall = { isStatic: true, restitution: 1, friction: 0, label: 'wall' };
    Composite.add(this.engine.world, [
      Bodies.rectangle(s / 2, -t / 2, s + t * 2, t, wall),
      Bodies.rectangle(s / 2, s + t / 2, s + t * 2, t, wall),
      Bodies.rectangle(-t / 2, s / 2, t, s + t * 2, wall),
      Bodies.rectangle(s + t / 2, s / 2, t, s + t * 2, wall),
    ]);
    Events.on(this.engine, 'collisionStart', (ev) => this.onCollisions(ev.pairs));
    this.startRound();
  }

  // ---------- публично API ----------

  /** Реално време от последния кадър (ms). Физиката е с фиксирана стъпка. */
  update(dtMs: number) {
    this.acc += Math.min(dtMs, 250);
    let steps = 0;
    while (this.acc >= STEP && steps < 6) {
      this.step();
      this.acc -= STEP;
      steps++;
    }
    if (steps === 6) this.acc = 0;
    this.flushNotices();
  }

  apply(e: LiveEvent) {
    if (e.kind === 'join') {
      const c = this.champ(e.team);
      if (c.alive) this.floatText(c.body.position.x, c.body.position.y - c.radius - 10, `+${e.user.name}`, c.team.color, 22);
      return;
    }
    if (this.phase !== 'fight') {
      if (e.kind === 'gift') {
        this.pending.push(e);
        this.say({ type: 'toast', text: `${e.user.name}: ${e.giftName} x${e.count} → ${TEAM_BY_ID[e.team].emoji} (в следващия рунд)`, team: e.team, level: 0 });
      }
      this.flushNotices();
      return;
    }
    switch (e.kind) {
      case 'gift':
        this.applyGift(e);
        break;
      case 'like':
        this.applyLike(e.team, e.count);
        break;
      case 'share':
        if (e.team) {
          const c = this.champ(e.team);
          if (c.alive) {
            this.heal(c, c.maxHp * GAME.shareHeal);
            this.grow(c, 1);
            this.floatText(c.body.position.x, c.body.position.y - c.radius, '📤 +10%', c.team.color, 26);
          }
        }
        break;
      case 'follow':
        if (e.team) {
          const c = this.champ(e.team);
          if (c.alive) this.spawnMinions(c, GAME.followMinions);
        }
        break;
    }
    this.flushNotices();
  }

  hud(): HudState {
    const timeLeft = Math.max(0, Math.ceil((this.phaseEnd - this.now) / 1000));
    return {
      phase: this.phase,
      round: this.round,
      timeLeft,
      rage: this.isRage(),
      winner: this.winner,
      teams: this.champions.map((c) => ({
        id: c.team.id,
        emoji: c.team.emoji,
        name: c.team.name,
        color: c.team.color,
        hp: Math.max(0, c.hp),
        maxHp: c.maxHp,
        alive: c.alive,
        shield: c.shieldUntil > this.now,
        dash: c.dashUntil > this.now,
        minions: this.minions.filter((m) => !m.dead && m.team.id === c.team.id).length,
      })),
    };
  }

  champ(team: TeamId): Champion {
    return this.champions.find((c) => c.team.id === team)!;
  }

  isRage() {
    return this.phase === 'fight' && this.phaseEnd - this.now <= GAME.rageSec * 1000;
  }

  // ---------- рунд ----------

  private startRound() {
    for (const c of this.champions) this.removeBody(c.body);
    for (const m of this.minions) this.removeBody(m.body);
    this.champions = [];
    this.minions = [];
    this.projectiles = [];
    this.timers = [];
    this.winner = null;
    this.round++;
    this.roundId = `${Date.now().toString(36)}-${this.round}`;

    const cx = this.size / 2;
    const ring = this.size * 0.33;
    const offset = Math.random() * Math.PI * 2;
    TEAMS.forEach((team, i) => {
      const a = offset + (i / TEAMS.length) * Math.PI * 2;
      this.champions.push(this.makeChampion(team, cx + Math.cos(a) * ring, cx + Math.sin(a) * ring));
    });

    this.phase = 'countdown';
    this.phaseEnd = this.now + GAME.countdownSec * 1000;
    this.lastCountdown = -1;
    this.say({ type: 'roundStart', roundId: this.roundId, round: this.round });
  }

  private beginFight() {
    this.phase = 'fight';
    this.phaseEnd = this.now + GAME.roundSec * 1000;
    for (const c of this.champions) c.nextThink = this.now + rand(0, 300);
    this.say({ type: 'banner', title: 'БОЙ!', sub: `Рунд ${this.round}`, big: true });
    this.say({ type: 'sfx', name: 'start' });
    const queued = this.pending.splice(0);
    queued.forEach((e, i) => {
      if (e.kind === 'gift' && tierFor(e.coins).action === 'crown') {
        // корона, пратена между рундовете: не печели 0-секунден рунд, а дава метеор + щит
        this.at(400 + i * 150, () => {
          const c = this.champ(e.team);
          c.shieldUntil = this.now + GAME.shieldMs;
          this.meteor(c, e.user.name);
        });
        return;
      }
      this.at(300 + i * 120, () => this.applyGift(e as Extract<LiveEvent, { kind: 'gift' }>));
    });
  }

  private endRound(winner: TeamId | null, reason: RoundEndReason, by?: { name: string; coins: number }) {
    if (this.phase !== 'fight') return;
    this.phase = 'end';
    this.phaseEnd = this.now + GAME.endSec * 1000;
    this.winner = winner;
    this.timers = [];
    this.projectiles = [];
    const w = winner ? TEAM_BY_ID[winner] : null;
    const why = reason === 'crown' ? `${by?.name} открадна короната` : reason === 'last' ? 'последен оцелял' : 'най-много живот';
    this.say({ type: 'banner', title: w ? `${w.emoji} ПОБЕДА` : 'НЯМА ПОБЕДИТЕЛ', sub: w ? `${w.name}: ${why}` : '', team: winner ?? undefined, big: true });
    this.say({ type: 'sfx', name: 'win' });
    this.say({ type: 'say', text: w ? `Победител в рунд ${this.round}: ${w.name}!` : 'Няма победител.' });
    this.say({ type: 'roundEnd', roundId: this.roundId, winner, reason, by });
    if (w) {
      const c = this.champ(w.id);
      if (!c.alive) this.revive(c, 1);
      for (let i = 0; i < 80; i++) this.confetti(c.body.position.x, c.body.position.y);
    }
  }

  // ---------- стъпка ----------

  private step() {
    this.now += STEP;
    const now = this.now;

    if (this.phase === 'countdown') {
      const left = Math.ceil((this.phaseEnd - now) / 1000);
      if (left !== this.lastCountdown && left > 0 && left <= 3) {
        this.lastCountdown = left;
        this.say({ type: 'banner', title: String(left), big: true });
        this.say({ type: 'sfx', name: 'tick' });
      }
      if (now >= this.phaseEnd) this.beginFight();
    } else if (this.phase === 'fight') {
      if (now >= this.phaseEnd) this.endByTime();
    } else if (this.phase === 'end' && now >= this.phaseEnd) {
      this.startRound();
    }

    // таймери (бомби, забавени ефекти)
    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= now);
      if (due.length) {
        this.timers = this.timers.filter((t) => t.at > now);
        for (const t of due) t.fn();
      }
    }

    this.think(now);
    Engine.update(this.engine, STEP);
    this.postPhysics(now);
  }

  private think(now: number) {
    const fighting = this.phase === 'fight';
    const alive = this.champions.filter((c) => c.alive);

    for (const c of alive) {
      if (this.phase === 'countdown') {
        Body.setVelocity(c.body, { x: 0, y: 0 });
        continue;
      }
      if (now < c.nextThink) continue;
      const dashing = c.dashUntil > now;
      const enemies = alive.filter((o) => o !== c);
      let tx = rand(0, this.size);
      let ty = rand(0, this.size);
      if (fighting && enemies.length && Math.random() < 0.72) {
        const near = enemies.reduce((best, o) => (dist(c, o) < dist(c, best) ? o : best), enemies[0]);
        tx = near.body.position.x;
        ty = near.body.position.y;
      }
      const ang = Math.atan2(ty - c.body.position.y, tx - c.body.position.x) + rand(-0.35, 0.35);
      const sizeSlow = Math.pow(GAME.baseRadius / c.radius, 0.3);
      const speed = rand(...GAME.impulseSpeed) * sizeSlow * (dashing ? 1.9 : 1) * (this.phase === 'end' ? 0.4 : 1);
      Body.setVelocity(c.body, { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed });
      c.nextThink = now + (dashing ? 380 : rand(...GAME.thinkEveryMs));
    }

    for (const m of this.minions) {
      if (m.dead || now < m.nextThink) continue;
      m.nextThink = now + 280;
      const enemies = alive.filter((o) => o.team.id !== m.team.id);
      if (!enemies.length) continue;
      const tgt = enemies.reduce((best, o) => (distXY(m.body.position, o.body.position) < distXY(m.body.position, best.body.position) ? o : best), enemies[0]);
      const ang = Math.atan2(tgt.body.position.y - m.body.position.y, tgt.body.position.x - m.body.position.x);
      Body.setVelocity(m.body, { x: Math.cos(ang) * 7.5, y: Math.sin(ang) * 7.5 });
    }
  }

  private postPhysics(now: number) {
    const dt = STEP / 1000;
    for (const c of this.champions) {
      if (!c.alive) continue;
      if (this.phase === 'fight' && !this.isRage() && now - c.lastHitAt > 2500) c.hp = Math.min(c.maxHp, c.hp + GAME.regenPerSec * dt);
      if (c.flash > 0) c.flash = Math.max(0, c.flash - dt * 4);
      if (!this.lite) {
        c.trail.push({ x: c.body.position.x, y: c.body.position.y });
        if (c.trail.length > (c.dashUntil > now ? 14 : 4)) c.trail.shift();
      }
      // защита при пробиване на стена
      const p = c.body.position;
      if (p.x < 0 || p.y < 0 || p.x > this.size || p.y > this.size) {
        Body.setPosition(c.body, { x: clamp(p.x, c.radius, this.size - c.radius), y: clamp(p.y, c.radius, this.size - c.radius) });
      }
    }

    for (const m of this.minions) {
      if (!m.dead && now - m.bornAt > GAME.minionTtlMs) this.killMinion(m, false);
    }
    if (this.minions.some((m) => m.dead)) this.minions = this.minions.filter((m) => !m.dead);

    for (const pr of [...this.projectiles]) {
      const t = Math.min(1, (now - pr.start) / pr.dur);
      const e = t * t;
      const tx = pr.target.body.position.x;
      const ty = pr.target.body.position.y;
      pr.x = pr.fromX + (tx - pr.fromX) * e;
      pr.y = pr.fromY + (ty - pr.fromY) * e;
      if (t >= 1) {
        this.projectiles.splice(this.projectiles.indexOf(pr), 1);
        pr.onHit();
      }
    }

    if (!this.lite) {
      for (const p of this.particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const drag = p.drag ?? 0.92;
        p.vx *= drag;
        p.vy *= drag;
        p.life -= dt;
      }
      if (this.particles.length) this.particles = this.particles.filter((p) => p.life > 0);
      if (this.particles.length > 900) this.particles.splice(0, this.particles.length - 900);
    }
  }

  // ---------- сблъсъци ----------

  private onCollisions(pairs: Matter.Pair[]) {
    if (this.phase !== 'fight') return;
    for (const pair of pairs) {
      const a = this.byBody.get(pair.bodyA.id);
      const b = this.byBody.get(pair.bodyB.id);
      if (!a || !b || a.team.id === b.team.id) continue;

      if (a.kind === 'minion' && b.kind === 'minion') {
        this.killMinion(a, true);
        this.killMinion(b, true);
        continue;
      }
      if (a.kind === 'minion' || b.kind === 'minion') {
        const m = (a.kind === 'minion' ? a : b) as Minion;
        const c = (a.kind === 'champ' ? a : b) as Champion;
        if (m.dead) continue;
        this.killMinion(m, true);
        this.damage(c, GAME.minionDamage * this.rageMul(), m.team.id);
        continue;
      }

      const ca = a as Champion;
      const cb = b as Champion;
      const rvx = ca.body.velocity.x - cb.body.velocity.x;
      const rvy = ca.body.velocity.y - cb.body.velocity.y;
      const impact = Math.hypot(rvx, rvy);
      if (impact < GAME.minImpact) continue;
      const ma = ca.body.mass;
      const mb = cb.body.mass;
      const base = GAME.hitDamage * impact * this.rageMul();
      const toB = base * (2 * ma) / (ma + mb) * (ca.dashUntil > this.now ? GAME.dashDamage : 1);
      const toA = base * (2 * mb) / (ma + mb) * (cb.dashUntil > this.now ? GAME.dashDamage : 1);
      this.damage(cb, toB, ca.team.id);
      this.damage(ca, toA, cb.team.id);

      if (!this.lite) {
        const sx = (ca.body.position.x + cb.body.position.x) / 2;
        const sy = (ca.body.position.y + cb.body.position.y) / 2;
        this.sparks(sx, sy, Math.min(14, 3 + impact), '#ffffff');
        if (Math.max(toA, toB) > 5) this.say({ type: 'sfx', name: 'hit' });
      }
    }
  }

  private rageMul() {
    return this.isRage() ? GAME.rageMultiplier : 1;
  }

  private damage(c: Champion, amount: number, from: TeamId) {
    if (!c.alive || this.phase !== 'fight') return;
    if (c.shieldUntil > this.now) {
      if (!this.lite && Math.random() < 0.3) this.floatText(c.body.position.x, c.body.position.y - c.radius, '🛡️', '#7fe7ff', 26);
      return;
    }
    c.hp -= amount;
    c.flash = 1;
    c.lastHitBy = from;
    c.lastHitAt = this.now;
    if (!this.lite && amount >= 4) {
      this.floatText(c.body.position.x + rand(-20, 20), c.body.position.y - c.radius * 0.6, `-${Math.round(amount)}`, '#ff6b6b', 20);
    }
    if (c.hp <= 0) this.eliminate(c);
  }

  private eliminate(c: Champion) {
    c.alive = false;
    c.hp = 0;
    this.removeBody(c.body);
    const killer = c.lastHitBy ? TEAM_BY_ID[c.lastHitBy] : null;
    this.explode(c.body.position.x, c.body.position.y, c.team.color, 50);
    this.say({ type: 'sfx', name: 'ko' });
    this.say({ type: 'shake', power: 12 });
    this.say({ type: 'toast', text: `${c.team.emoji} ${c.team.name} е елиминиран${killer ? ` от ${killer.emoji}` : ''}. Подарък го връща!`, team: c.team.id, level: 1 });
    for (const m of this.minions) if (m.team.id === c.team.id) this.killMinion(m, true);
    const alive = this.champions.filter((x) => x.alive);
    if (alive.length <= 1) this.endRound(alive[0]?.team.id ?? c.lastHitBy, 'last');
  }

  private endByTime() {
    const alive = this.champions.filter((c) => c.alive);
    if (!alive.length) return this.endRound(null, 'none');
    const best = alive.reduce((a, b) => (b.hp > a.hp || (b.hp === a.hp && b.radius > a.radius) ? b : a));
    this.endRound(best.team.id, 'time');
  }

  // ---------- ефекти от подаръци ----------

  private applyGift(e: Extract<LiveEvent, { kind: 'gift' }>) {
    if (this.phase !== 'fight') {
      this.pending.push(e);
      return;
    }
    const c = this.champ(e.team);
    const tier = tierFor(e.coins);
    const level = TIERS.indexOf(tier);
    const n = Math.min(e.count, GAME.maxRepeatPerEvent);
    const who = e.user.name;
    const em = c.team.emoji;

    if (!c.alive) {
      this.revive(c, GAME.reviveHp);
      this.say({ type: 'toast', text: `${who} ВЪЗКРЕСИ ${em}!`, team: c.team.id, level: 1 });
    }

    const countTxt = e.count > 1 ? ` x${e.count}` : '';
    const toastLevel = (level >= 4 ? 2 : level >= 2 ? 1 : 0) as 0 | 1 | 2;
    if (tier.action !== 'crown') {
      this.say({ type: 'toast', text: `${who}: ${e.giftName}${countTxt} → ${em} ${tier.icon} ${tier.label}`, team: c.team.id, level: toastLevel });
    }

    switch (tier.action) {
      case 'grow':
        this.grow(c, n);
        this.heal(c, n);
        this.say({ type: 'sfx', name: 'grow' });
        break;
      case 'dash':
        c.dashUntil = Math.min(Math.max(c.dashUntil, this.now) + GAME.dashMs * n, this.now + 15000);
        c.nextThink = this.now;
        this.say({ type: 'sfx', name: 'dash' });
        break;
      case 'minions':
        this.spawnMinions(c, GAME.minionsPerGift * n);
        this.say({ type: 'sfx', name: 'pop' });
        break;
      case 'shield':
        c.shieldUntil = Math.min(Math.max(c.shieldUntil, this.now) + GAME.shieldMs * n, this.now + 60000);
        this.say({ type: 'sfx', name: 'shield' });
        break;
      case 'bomb':
        for (let i = 0; i < Math.min(n, 5); i++) this.at(i * 300, () => this.bomb(c, who));
        if (e.coins * e.count >= 300) this.say({ type: 'say', text: `${who} пусна бомба!` });
        break;
      case 'meteor':
        for (let i = 0; i < Math.min(n, 3); i++) this.at(i * 1600, () => this.meteor(c, who));
        this.say({ type: 'banner', title: '☄️ МЕТЕОР', sub: `${who} за ${em}`, team: c.team.id });
        this.say({ type: 'say', text: `Метеор от ${who}!` });
        break;
      case 'crown':
        this.say({ type: 'toast', text: `👑 ${who} открадна короната за ${em}!`, team: c.team.id, level: 2 });
        this.say({ type: 'sfx', name: 'crown' });
        this.say({ type: 'shake', power: 30 });
        this.endRound(c.team.id, 'crown', { name: who, coins: e.coins * e.count });
        break;
    }
  }

  private applyLike(team: TeamId | null, count: number) {
    if (!team) return;
    const c = this.champ(team);
    if (!c.alive) return;
    this.heal(c, Math.min(count, 40) * GAME.likeHeal);
    const last = this.lastHeart.get(team) ?? 0;
    if (!this.lite && this.now - last > 250) {
      this.lastHeart.set(team, this.now);
      this.particles.push({
        x: c.body.position.x + rand(-c.radius, c.radius) * 0.6,
        y: c.body.position.y - c.radius * 0.5,
        vx: rand(-20, 20),
        vy: -90,
        life: 1.1,
        max: 1.1,
        size: 26,
        color: '#ff4d8d',
        emoji: '❤️',
        drag: 0.99,
      });
    }
  }

  private grow(c: Champion, times: number) {
    for (let i = 0; i < times; i++) {
      const next = Math.min(GAME.maxRadius, c.radius * GAME.growFactor);
      if (next <= c.radius + 0.01) break;
      const k = next / c.radius;
      Body.scale(c.body, k, k);
      Body.setInertia(c.body, Infinity);
      const oldMax = c.maxHp;
      c.radius = next;
      c.maxHp = GAME.baseHp * Math.pow(c.radius / GAME.baseRadius, 1.5);
      c.hp += c.maxHp - oldMax;
    }
    if (!this.lite) this.sparks(c.body.position.x, c.body.position.y, 8, c.team.color);
  }

  private heal(c: Champion, amount: number) {
    c.hp = Math.min(c.maxHp, c.hp + amount);
  }

  private spawnMinions(c: Champion, count: number) {
    const have = this.minions.filter((m) => m.team.id === c.team.id).length;
    const n = Math.max(0, Math.min(count, GAME.maxMinionsPerTeam - have));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 20;
      const x = clamp(c.body.position.x + Math.cos(a) * (c.radius + r + 4), r, this.size - r);
      const y = clamp(c.body.position.y + Math.sin(a) * (c.radius + r + 4), r, this.size - r);
      const body = Bodies.circle(x, y, r, { restitution: 0.9, friction: 0, frictionAir: 0.02, density: 0.0008, label: 'minion' });
      Body.setInertia(body, Infinity);
      const m: Minion = { kind: 'minion', team: c.team, body, radius: r, bornAt: this.now, dead: false, nextThink: this.now + i * 40 };
      this.addBody(body, m);
      this.minions.push(m);
    }
  }

  private killMinion(m: Minion, pop: boolean) {
    if (m.dead) return;
    m.dead = true;
    this.removeBody(m.body);
    if (pop && !this.lite) this.sparks(m.body.position.x, m.body.position.y, 6, m.team.color);
  }

  private leaderEnemy(c: Champion): Champion | null {
    const enemies = this.champions.filter((o) => o.alive && o !== c);
    if (!enemies.length) return null;
    return enemies.reduce((a, b) => (b.hp > a.hp ? b : a));
  }

  private bomb(from: Champion, who: string) {
    const target = this.leaderEnemy(from);
    if (!target) return this.grow(from, 3);
    this.projectiles.push({
      kind: 'bomb',
      team: from.team.id,
      fromX: target.body.position.x,
      fromY: -120,
      x: target.body.position.x,
      y: -120,
      target,
      start: this.now,
      dur: 900,
      onHit: () => {
        if (this.phase !== 'fight') return;
        const pos = { ...target.body.position };
        if (target.alive) {
          const mult = target.shieldUntil > this.now ? 0.3 : 1;
          const shield = target.shieldUntil;
          target.shieldUntil = 0; // бомбата пробива щита частично
          this.damage(target, target.maxHp * GAME.bombDamage * mult, from.team.id);
          target.shieldUntil = shield;
        }
        for (const o of this.champions) {
          if (!o.alive || o === target || o.team.id === from.team.id) continue;
          const d = distXY(o.body.position, pos);
          if (d < GAME.bombRadius) {
            this.damage(o, o.maxHp * GAME.bombSplash, from.team.id);
            this.push(o, pos, 14);
          }
        }
        if (target.alive) this.push(target, pos, 10);
        this.explode(pos.x, pos.y, '#ffb703', 60);
        this.say({ type: 'sfx', name: 'bomb' });
        this.say({ type: 'shake', power: 18 });
        this.floatText(pos.x, pos.y - 40, `💣 ${who}`, '#ffd166', 30);
      },
    });
  }

  private meteor(from: Champion, who: string) {
    const enemies = this.champions.filter((o) => o.alive && o.team.id !== from.team.id);
    this.say({ type: 'sfx', name: 'meteor' });
    for (const t of enemies) {
      this.projectiles.push({
        kind: 'meteor',
        team: from.team.id,
        fromX: t.body.position.x - 500,
        fromY: -300,
        x: t.body.position.x - 500,
        y: -300,
        target: t,
        start: this.now + rand(0, 200),
        dur: 1200,
        onHit: () => {
          if (this.phase !== 'fight' || !t.alive) return;
          const mult = t.shieldUntil > this.now ? 0.4 : 1;
          const shield = t.shieldUntil;
          t.shieldUntil = 0;
          this.damage(t, t.maxHp * GAME.meteorDamage * mult, from.team.id);
          t.shieldUntil = shield;
          this.explode(t.body.position.x, t.body.position.y, '#ff5d2c', 40);
        },
      });
    }
    this.at(1300, () => {
      for (const m of this.minions) if (m.team.id !== from.team.id) this.killMinion(m, true);
      this.say({ type: 'shake', power: 30 });
      this.floatText(this.size / 2, this.size / 2, `☄️ ${who}`, '#ff8c42', 44);
    });
  }

  private revive(c: Champion, hpShare: number) {
    const spot = this.freeSpot(c.radius);
    const fresh = this.makeChampion(c.team, spot.x, spot.y);
    // запазва размера
    const k = c.radius / fresh.radius;
    if (k > 1.01) {
      Body.scale(fresh.body, k, k);
      Body.setInertia(fresh.body, Infinity);
      fresh.radius = c.radius;
    }
    Object.assign(c, {
      body: fresh.body,
      radius: fresh.radius,
      alive: true,
      maxHp: GAME.baseHp * Math.pow(fresh.radius / GAME.baseRadius, 1.5),
      shieldUntil: this.now + 3000,
      dashUntil: 0,
      nextThink: this.now + 200,
      flash: 1,
      trail: [],
    });
    c.hp = c.maxHp * hpShare;
    this.byBody.delete(fresh.body.id);
    this.byBody.set(c.body.id, c);
    this.say({ type: 'sfx', name: 'revive' });
    this.floatText(spot.x, spot.y - c.radius - 10, 'ВЪЗКРЕСЕН!', c.team.color, 30);
  }

  // ---------- помощни ----------

  private makeChampion(team: TeamDef, x: number, y: number): Champion {
    const r = GAME.baseRadius;
    const body = Bodies.circle(x, y, r, { restitution: 0.92, friction: 0, frictionStatic: 0, frictionAir: 0.012, density: 0.001, label: team.id });
    Body.setInertia(body, Infinity);
    const c: Champion = {
      kind: 'champ',
      team,
      body,
      radius: r,
      hp: GAME.baseHp,
      maxHp: GAME.baseHp,
      alive: true,
      shieldUntil: 0,
      dashUntil: 0,
      nextThink: 0,
      flash: 0,
      lastHitBy: null,
      lastHitAt: -1e9,
      trail: [],
    };
    this.addBody(body, c);
    return c;
  }

  private freeSpot(r: number) {
    let best = { x: this.size / 2, y: this.size / 2 };
    let bestD = -1;
    for (let i = 0; i < 24; i++) {
      const p = { x: rand(r, this.size - r), y: rand(r, this.size - r) };
      const d = Math.min(...this.champions.filter((c) => c.alive).map((c) => distXY(p, c.body.position) - c.radius), 1e9);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private push(c: Champion, from: { x: number; y: number }, speed: number) {
    const a = Math.atan2(c.body.position.y - from.y, c.body.position.x - from.x);
    Body.setVelocity(c.body, { x: Math.cos(a) * speed, y: Math.sin(a) * speed });
  }

  private addBody(body: Matter.Body, e: Entity) {
    this.byBody.set(body.id, e);
    Composite.add(this.engine.world, body);
  }

  private removeBody(body: Matter.Body) {
    this.byBody.delete(body.id);
    Composite.remove(this.engine.world, body);
  }

  private at(delayMs: number, fn: () => void) {
    this.timers.push({ at: this.now + delayMs, fn });
  }

  private say(n: Notice) {
    this.notices.push(n);
  }

  private flushNotices() {
    if (!this.notices.length) return;
    const list = this.notices.splice(0);
    for (const n of list) this.notify(n);
  }

  floatText(x: number, y: number, text: string, color: string, size: number) {
    if (this.lite) return;
    this.particles.push({ x, y, vx: 0, vy: -60, life: 1.4, max: 1.4, size, color, text, drag: 0.97 });
  }

  private sparks(x: number, y: number, n: number, color: string) {
    if (this.lite) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(120, 420);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.25, 0.5), max: 0.5, size: rand(3, 6), color });
    }
  }

  private explode(x: number, y: number, color: string, n: number) {
    if (this.lite) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(150, 700);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.4, 1), max: 1, size: rand(4, 11), color: Math.random() < 0.3 ? '#ffffff' : color, drag: 0.9 });
    }
  }

  private confetti(x: number, y: number) {
    if (this.lite) return;
    const colors = ['#ffd23f', '#ff4d6d', '#58d858', '#6ff0c0', '#c77dff', '#ffffff'];
    const a = Math.random() * Math.PI * 2;
    const s = rand(200, 800);
    this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(1, 2.2), max: 2.2, size: rand(5, 10), color: colors[Math.floor(Math.random() * colors.length)], drag: 0.95 });
  }
}

function dist(a: Champion, b: Champion) {
  return distXY(a.body.position, b.body.position);
}

function distXY(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
