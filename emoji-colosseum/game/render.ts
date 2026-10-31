import type { Game } from './engine';

// Рисува арената в canvas. Емоджитата се рендерират веднъж в offscreen canvas
// и после само се мащабират: така се държат 60fps и на слаб VPS без GPU.

const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';
const SPRITE = 160;

export class Renderer {
  private sprites = new Map<string, HTMLCanvasElement>();
  private bg: HTMLCanvasElement | null = null;
  /** font-family за текстовете в canvas (CSS променливи не работят там) */
  textFont = 'system-ui, sans-serif';

  constructor(private ctx: CanvasRenderingContext2D, private game: Game) {}

  private sprite(emoji: string) {
    let s = this.sprites.get(emoji);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = SPRITE;
    s.height = SPRITE;
    const c = s.getContext('2d')!;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `${SPRITE * 0.8}px ${EMOJI_FONT}`;
    c.fillText(emoji, SPRITE / 2, SPRITE / 2 + SPRITE * 0.05);
    this.sprites.set(emoji, s);
    return s;
  }

  private drawEmoji(emoji: string, x: number, y: number, size: number, alpha = 1) {
    const ctx = this.ctx;
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.drawImage(this.sprite(emoji), x - size / 2, y - size / 2, size, size);
    if (alpha !== 1) ctx.globalAlpha = 1;
  }

  private background(size: number) {
    if (this.bg) return this.bg;
    const b = document.createElement('canvas');
    b.width = size;
    b.height = size;
    const c = b.getContext('2d')!;
    const g = c.createRadialGradient(size / 2, size / 2, 40, size / 2, size / 2, size * 0.75);
    g.addColorStop(0, '#1d1640');
    g.addColorStop(1, '#0a0818');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    c.strokeStyle = 'rgba(255,255,255,0.045)';
    c.lineWidth = 1;
    for (let i = 75; i < size; i += 75) {
      c.beginPath();
      c.moveTo(i, 0);
      c.lineTo(i, size);
      c.moveTo(0, i);
      c.lineTo(size, i);
      c.stroke();
    }
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    c.lineWidth = 3;
    c.beginPath();
    c.arc(size / 2, size / 2, size * 0.33, 0, Math.PI * 2);
    c.stroke();
    this.bg = b;
    return b;
  }

  draw(timeMs: number) {
    const { ctx, game } = this;
    const S = game.size;
    const now = game.now;
    ctx.drawImage(this.background(S), 0, 0);

    // ярост: червено пулсиране по ръба
    if (game.isRage()) {
      const a = 0.25 + 0.2 * Math.sin(timeMs / 180);
      ctx.strokeStyle = `rgba(255,40,60,${a})`;
      ctx.lineWidth = 18;
      ctx.strokeRect(9, 9, S - 18, S - 18);
    }

    // следи при ускорение
    for (const c of game.champions) {
      if (!c.alive || c.trail.length < 2) continue;
      const dashing = c.dashUntil > now;
      c.trail.forEach((p, i) => {
        const k = i / c.trail.length;
        ctx.globalAlpha = (dashing ? 0.35 : 0.12) * k;
        ctx.fillStyle = c.team.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, c.radius * (0.5 + 0.5 * k), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    // миньони
    for (const m of game.minions) {
      if (m.dead) continue;
      const { x, y } = m.body.position;
      ctx.fillStyle = hexA(m.team.color, 0.3);
      ctx.strokeStyle = m.team.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, m.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      this.drawEmoji(m.team.emoji, x, y, m.radius * 1.5);
    }

    // шампиони
    for (const c of game.champions) {
      if (!c.alive) continue;
      const { x, y } = c.body.position;
      const r = c.radius;

      const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 1.5);
      glow.addColorStop(0, hexA(c.team.color, 0.35));
      glow.addColorStop(1, hexA(c.team.color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#120e26';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      this.drawEmoji(c.team.emoji, x, y, r * 1.62);

      if (c.flash > 0) {
        ctx.globalAlpha = c.flash * 0.55;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // HP пръстен
      const share = Math.max(0, c.hp / c.maxHp);
      ctx.lineCap = 'round';
      ctx.lineWidth = 9;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.arc(x, y, r + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = share > 0.3 ? c.team.color : '#ff3b3b';
      ctx.beginPath();
      ctx.arc(x, y, r + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * share);
      ctx.stroke();
      ctx.lineCap = 'butt';

      if (c.shieldUntil > now) {
        const left = (c.shieldUntil - now) / 1000;
        const blink = left < 3 ? 0.5 + 0.5 * Math.sin(timeMs / 60) : 1;
        ctx.strokeStyle = `rgba(127,231,255,${0.75 * blink})`;
        ctx.fillStyle = `rgba(127,231,255,${0.12 * blink})`;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(x, y, r + 20 + Math.sin(timeMs / 150) * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (c.dashUntil > now) this.drawEmoji('⚡', x + r * 0.8, y - r * 0.8, 42);
    }

    // корона на победителя
    if (game.phase === 'end' && game.winner) {
      const c = game.champ(game.winner);
      if (c.alive) {
        const bob = Math.sin(timeMs / 200) * 8;
        this.drawEmoji('👑', c.body.position.x, c.body.position.y - c.radius - 55 + bob, 110);
      }
    }

    // бомби и метеори
    for (const p of game.projectiles) {
      if (now < p.start) continue;
      const t = Math.min(1, (now - p.start) / p.dur);
      const tx = p.target.body.position.x;
      const ty = p.target.body.position.y;
      if (p.kind === 'bomb') {
        ctx.fillStyle = `rgba(0,0,0,${0.15 + 0.35 * t})`;
        ctx.beginPath();
        ctx.ellipse(tx, ty, 30 + 60 * t, 14 + 26 * t, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,80,80,${0.4 + 0.5 * t})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(tx, ty, 90 - 40 * t, 0, Math.PI * 2);
        ctx.stroke();
        this.drawEmoji('💣', p.x, p.y, 90 - 20 * t);
      } else {
        const g = ctx.createLinearGradient(p.fromX, p.fromY, p.x, p.y);
        g.addColorStop(0, 'rgba(255,120,40,0)');
        g.addColorStop(1, 'rgba(255,200,80,0.8)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 16;
        ctx.beginPath();
        ctx.moveTo(p.x - (p.x - p.fromX) * 0.35, p.y - (p.y - p.fromY) * 0.35);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        this.drawEmoji('☄️', p.x, p.y, 96);
      }
    }

    // частици и текстове
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of game.particles) {
      const a = Math.max(0, Math.min(1, p.life / p.max));
      if (p.text) {
        ctx.globalAlpha = Math.min(1, a * 1.6);
        ctx.font = `800 ${p.size}px ${this.textFont}`;
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
      } else if (p.emoji) {
        this.drawEmoji(p.emoji, p.x, p.y, p.size, a);
      } else {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * a), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    if (game.phase === 'countdown') {
      ctx.fillStyle = 'rgba(5,3,15,0.45)';
      ctx.fillRect(0, 0, S, S);
    }
  }
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
