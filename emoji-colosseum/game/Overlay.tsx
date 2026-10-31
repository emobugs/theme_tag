'use client';

import gsap from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { GAME, TEAMS, TEAM_BY_ID, TIERS, type TeamId } from '../shared/config';
import type { SourceKind, StatsSnapshot } from '../shared/events';
import { Sfx, Voice } from './audio';
import { Game, type HudState, type Notice } from './engine';
import { bridgeUrl, connectBridge, connectOffline, type Feed } from './feed';
import { Renderer } from './render';

const A = GAME.arena;

const INITIAL_HUD: HudState = {
  phase: 'countdown',
  round: 1,
  timeLeft: GAME.roundSec,
  rage: false,
  winner: null,
  teams: TEAMS.map((t) => ({
    id: t.id,
    emoji: t.emoji,
    name: t.name,
    color: t.color,
    hp: GAME.baseHp,
    maxHp: GAME.baseHp,
    alive: true,
    shield: false,
    dash: false,
    minions: 0,
  })),
};

function fmtTime(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtCoins(n: number) {
  return n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default function Overlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arenaRef = useRef<HTMLDivElement>(null);
  const toastsRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [hud, setHud] = useState<HudState>(INITIAL_HUD);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [status, setStatus] = useState<{ connected: boolean; source: SourceKind; status: string }>({
    connected: false,
    source: 'sim',
    status: 'свързване...',
  });
  const [debug, setDebug] = useState(false);
  const [needClick, setNeedClick] = useState(false);
  const sfxRef = useRef<Sfx | null>(null);

  // мащабиране на сцената 1080x1920 към прозореца
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / GAME.stageW, window.innerHeight / GAME.stageH));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    setDebug(params.get('debug') === '1');
    const muted = params.get('mute') === '1';
    const sfx = new Sfx(Number(params.get('vol') ?? 0.5), muted);
    sfxRef.current = sfx;
    const voice = new Voice(params.get('tts') !== '0');
    let primary = false;
    let feed: Feed | null = null;

    const pushToast = (n: Extract<Notice, { type: 'toast' }>) => {
      const box = toastsRef.current;
      if (!box) return;
      const el = document.createElement('div');
      el.className = `toast lvl-${n.level}`;
      el.textContent = n.text;
      if (n.team) el.style.setProperty('--c', TEAM_BY_ID[n.team].color);
      box.prepend(el);
      while (box.children.length > 5) box.lastElementChild?.remove();
      gsap.fromTo(el, { x: -80, opacity: 0, scale: 0.9 }, { x: 0, opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(2)' });
      gsap.to(el, { opacity: 0, x: -40, delay: n.level === 2 ? 7 : n.level === 1 ? 5 : 3.5, duration: 0.4, onComplete: () => el.remove() });
    };

    const showBanner = (n: Extract<Notice, { type: 'banner' }>) => {
      const el = bannerRef.current;
      if (!el) return;
      const short = /^\d$/.test(n.title);
      el.innerHTML = '';
      const t = document.createElement('div');
      t.className = `banner-title${n.big ? ' big' : ''}`;
      t.textContent = n.title;
      el.appendChild(t);
      if (n.sub) {
        const s = document.createElement('div');
        s.className = 'banner-sub';
        s.textContent = n.sub;
        el.appendChild(s);
      }
      el.style.setProperty('--c', n.team ? TEAM_BY_ID[n.team].color : '#ffd23f');
      gsap.killTweensOf(el);
      gsap
        .timeline()
        .fromTo(el, { opacity: 0, scale: 0.4, rotate: -6 }, { opacity: 1, scale: 1, rotate: 0, duration: 0.35, ease: 'back.out(2.2)' })
        .to(el, { opacity: 0, scale: 1.15, duration: 0.3, ease: 'power2.in' }, short ? 0.7 : n.big ? 3.2 : 2.2);
    };

    const shake = (power: number) => {
      const el = arenaRef.current;
      if (!el) return;
      gsap.killTweensOf(el, 'x,y');
      gsap.to(el, {
        x: () => gsap.utils.random(-power, power),
        y: () => gsap.utils.random(-power, power),
        duration: 0.04,
        repeat: Math.min(14, Math.ceil(power / 2)),
        repeatRefresh: true,
        ease: 'none',
        onComplete: () => {
          gsap.set(el, { x: 0, y: 0 });
        },
      });
    };

    const game = new Game((n) => {
      switch (n.type) {
        case 'toast':
          return pushToast(n);
        case 'banner':
          return showBanner(n);
        case 'sfx':
          return sfx.play(n.name);
        case 'shake':
          return shake(n.power);
        case 'say':
          return voice.say(n.text);
        case 'roundStart':
          if (primary) feed?.send({ t: 'roundStart', roundId: n.roundId });
          return;
        case 'roundEnd':
          if (primary) feed?.send({ t: 'roundEnd', roundId: n.roundId, winner: n.winner, reason: n.reason, by: n.by });
          return;
      }
    });

    const handlers = {
      onEvent: (e: Parameters<Game['apply']>[0]) => game.apply(e),
      onStats: (s: StatsSnapshot) => setStats(s),
      onStatus: (s: { connected: boolean; source: SourceKind; status: string }) => setStatus(s),
      onPrimary: (p: boolean) => {
        primary = p;
      },
    };
    feed = params.has('offline') ? connectOffline(handlers) : connectBridge(bridgeUrl(params), 'overlay', handlers);

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const renderer = new Renderer(ctx, game);
    const fontVar = getComputedStyle(document.documentElement).getPropertyValue('--font-display').trim();
    if (fontVar) renderer.textFont = `${fontVar}, system-ui, sans-serif`;

    let raf = 0;
    let last = performance.now();
    let hudAt = 0;
    const frame = (t: number) => {
      game.update(t - last);
      last = t;
      renderer.draw(t);
      if (t - hudAt > 200) {
        hudAt = t;
        setHud(game.hud());
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const unlock = () => sfx.unlock();
    window.addEventListener('pointerdown', unlock);
    const soundCheck = setTimeout(() => {
      sfx.unlock();
      setTimeout(() => setNeedClick(!muted && !sfx.ready), 300);
    }, 800);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(soundCheck);
      window.removeEventListener('pointerdown', unlock);
      feed?.close();
    };
  }, []);

  const leader = hud.winner ?? hud.teams.filter((t) => t.alive).sort((a, b) => b.hp - a.hp)[0]?.id;
  const winsSorted = stats ? [...TEAMS].sort((a, b) => stats.todayWins[b.id] - stats.todayWins[a.id]) : [...TEAMS];
  const maxWins = stats ? Math.max(1, ...Object.values(stats.todayWins)) : 1;

  return (
    <div className="viewport">
      <div className="stage" style={{ width: GAME.stageW, height: GAME.stageH, transform: `translate(-50%, -50%) scale(${scale})` }}>
        <div className="sky" />

        <header className="header">
          <div className="logo">
            <span className="logo-top">EMOJI</span>
            <span className="logo-bottom">КОЛИЗЕУМ</span>
          </div>
          <div className={`timer${hud.rage ? ' rage' : ''}`}>
            <div className="timer-round">РУНД {hud.round}</div>
            <div className="timer-value">
              {hud.phase === 'fight' ? fmtTime(hud.timeLeft) : hud.phase === 'countdown' ? 'СТАРТ' : 'КРАЙ'}
            </div>
            {hud.rage && <div className="timer-rage">ЯРОСТ x{GAME.rageMultiplier}</div>}
          </div>
        </header>

        <section className="teams">
          {hud.teams.map((t) => {
            const share = t.maxHp ? Math.max(0, t.hp / t.maxHp) : 0;
            return (
              <div
                key={t.id}
                className={`team${t.alive ? '' : ' dead'}${leader === t.id ? ' leader' : ''}${hud.winner === t.id ? ' winner' : ''}`}
                style={{ ['--c' as string]: t.color }}
              >
                <div className="team-emoji">{t.alive ? t.emoji : '💀'}</div>
                <div className="team-body">
                  <div className="team-row">
                    <span className="team-name">{t.emoji} {t.name}</span>
                    <span className="team-tags">
                      {t.shield && '🛡️'}
                      {t.dash && '⚡'}
                      {t.minions > 0 && `🐣${t.minions}`}
                      {leader === t.id && '👑'}
                    </span>
                  </div>
                  <div className="hp">
                    <div className="hp-fill" style={{ width: `${share * 100}%` }} />
                  </div>
                  <div className="team-row small">
                    <span>{t.alive ? `${Math.ceil(t.hp)} HP` : 'подарък = връщане'}</span>
                    <span>👥 {stats?.members[t.id as TeamId] ?? 0}</span>
                    <span>🪙 {fmtCoins(stats?.roundCoins[t.id as TeamId] ?? 0)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        <div className="arena" ref={arenaRef} style={{ left: A.x, top: A.y, width: A.size, height: A.size }}>
          <canvas ref={canvasRef} width={A.size} height={A.size} />
          <div className="toasts" ref={toastsRef} />
          <div className="banner" ref={bannerRef} />
        </div>

        <div className="cta">
          Пиши в чата {TEAMS.map((t) => t.emoji).join(' ')} и влез в отбор
        </div>

        <section className="tiers">
          {TIERS.map((t) => (
            <div key={t.action} className="tier">
              <div className="tier-icon">{t.icon}</div>
              <div className="tier-coins">{t.min >= 1000 ? `${t.min / 1000}k+` : `${t.min}+`}</div>
              <div className="tier-label">{t.label}</div>
            </div>
          ))}
        </section>

        <section className="boards">
          <div className="board">
            <h3>Топ дарители: рунд</h3>
            {(stats?.roundTop.length ? stats.roundTop : []).map((g, i) => (
              <div className="row" key={g.id}>
                <span className="pos">{i + 1}</span>
                <span className="who">
                  {TEAM_BY_ID[g.team]?.emoji} {g.name}
                </span>
                <span className="val">🪙 {fmtCoins(g.coins)}</span>
              </div>
            ))}
            {!stats?.roundTop.length && <div className="empty">Първият подарък те слага тук</div>}
            <h3 className="mt">Топ днес</h3>
            {(stats?.todayTop ?? []).slice(0, 3).map((g, i) => (
              <div className="row" key={g.id}>
                <span className="pos">{['🥇', '🥈', '🥉'][i]}</span>
                <span className="who">
                  {TEAM_BY_ID[g.team]?.emoji} {g.name}
                </span>
                <span className="val">🪙 {fmtCoins(g.coins)}</span>
              </div>
            ))}
          </div>
          <div className="board">
            <h3>Победи днес</h3>
            {winsSorted.slice(0, 5).map((t) => (
              <div className="win-row" key={t.id} style={{ ['--c' as string]: t.color }}>
                <span className="win-emoji">{t.emoji}</span>
                <div className="win-bar">
                  <div style={{ width: `${((stats?.todayWins[t.id] ?? 0) / maxWins) * 100}%` }} />
                </div>
                <span className="val">{stats?.todayWins[t.id] ?? 0}</span>
              </div>
            ))}
            <h3 className="mt">Зала на славата 👑</h3>
            {stats?.fame.length ? (
              stats.fame.slice(0, 2).map((f) => (
                <div className="row" key={f.at}>
                  <span className="who">
                    {TEAM_BY_ID[f.team]?.emoji} {f.name}
                  </span>
                  <span className="val">🪙 {fmtCoins(f.coins)}</span>
                </div>
              ))
            ) : (
              <div className="empty">10k монети и името ти остава тук</div>
            )}
          </div>
        </section>

        {(debug || !status.connected) && (
          <div className={`status${status.connected ? ' ok' : ''}`}>
            ● {status.status}
          </div>
        )}
        {needClick && (
          <button
            className="sound"
            onClick={() => {
              sfxRef.current?.unlock();
              setNeedClick(false);
            }}
          >
            🔊 Кликни за звук
          </button>
        )}
      </div>
    </div>
  );
}
