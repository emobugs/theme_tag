'use client';

import { useEffect, useRef, useState } from 'react';
import { TEAMS, TEAM_BY_ID, TIERS, type TeamId } from '../../shared/config';
import type { InjectMsg, LiveEvent, StatsSnapshot } from '../../shared/events';
import { bridgeUrl, connectBridge, type Feed, type FeedStatus } from '../../game/feed';

function describe(e: LiveEvent): string {
  const em = e.team ? TEAM_BY_ID[e.team].emoji : '·';
  switch (e.kind) {
    case 'join':
      return `${em} ${e.user.name} ${e.switched ? 'смени отбора' : 'влезе'}`;
    case 'gift':
      return `${em} ${e.user.name}: ${e.giftName} x${e.count} (${e.coins * e.count} 🪙)`;
    case 'like':
      return `${em} ${e.user.name}: ❤️ x${e.count}`;
    case 'share':
      return `${em} ${e.user.name}: 📤 сподели`;
    case 'follow':
      return `${em} ${e.user.name}: ➕ последва`;
  }
}

export default function Control() {
  const feedRef = useRef<Feed | null>(null);
  const [status, setStatus] = useState<FeedStatus>({
    connected: false,
    source: 'sim',
    platforms: [],
    status: 'свързване...',
    sim: false,
  });
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [team, setTeam] = useState<TeamId>(TEAMS[0].id);
  const [name, setName] = useState('Тест');
  const [count, setCount] = useState(1);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const feed = connectBridge(bridgeUrl(params), 'control', {
      onStatus: setStatus,
      onStats: setStats,
      onEvent: (e) => setLog((l) => [describe(e), ...l].slice(0, 80)),
    });
    feedRef.current = feed;
    return () => feed.close();
  }, []);

  const inject = (e: InjectMsg) => feedRef.current?.send({ t: 'inject', e });

  return (
    <main className="page">
      <h1>Контролен панел</h1>
      <p>
        <span className={`pill${status.connected ? ' ok' : ''}`}>● {status.status}</span>
      </p>

      <div className="card">
        <h2>Зрител</h2>
        <div className="inline">
          <label className="field">
            Име
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
          </label>
          <label className="field">
            Брой (серия)
            <input
              type="number"
              min={1}
              max={999}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(999, Number(e.target.value) || 1)))}
            />
          </label>
        </div>
        <div className="team-picker">
          {TEAMS.map((t) => (
            <button
              key={t.id}
              className={team === t.id ? 'on' : ''}
              style={{ ['--c' as string]: t.color }}
              onClick={() => setTeam(t.id)}
              aria-label={t.name}
            >
              {t.emoji}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Подаръци за {TEAM_BY_ID[team].emoji} {TEAM_BY_ID[team].name}</h2>
        <div className="btn-grid">
          {TIERS.map((t) => (
            <button
              key={t.action}
              onClick={() => inject({ kind: 'gift', name, team, coins: t.min, count, giftName: `${t.icon} ${t.min} монети` })}
            >
              {t.icon} {t.min} 🪙<small>{t.label}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Чат и взаимодействие</h2>
        <div className="btn-grid">
          <button onClick={() => inject({ kind: 'chat', name, text: TEAM_BY_ID[team].emoji })}>
            💬 Пише {TEAM_BY_ID[team].emoji}
            <small>влиза в отбора</small>
          </button>
          <button onClick={() => inject({ kind: 'like', name, count: 20 })}>
            ❤️ 20 лайка<small>лекува отбора си</small>
          </button>
          <button onClick={() => inject({ kind: 'share', name })}>
            📤 Споделяне<small>+10% HP и расте</small>
          </button>
          <button onClick={() => inject({ kind: 'follow', name })}>
            ➕ Последване<small>1 миньон</small>
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Симулатор</h2>
        <p style={{ marginTop: 0 }}>Пуска фалшиви зрители през bridge-а. Полезно за тест на overlay-а в OBS.</p>
        <button className="btn" style={{ width: '100%' }} onClick={() => feedRef.current?.send({ t: 'sim', on: !status.sim })}>
          {status.sim ? '⏹ Спри симулатора' : '▶️ Пусни симулатора'}
        </button>
      </div>

      {stats && (
        <div className="card">
          <h2>Днес ({stats.date}) · рундове общо: {stats.rounds}</h2>
          <div className="log">
            {TEAMS.map((t) => (
              <div key={t.id}>
                {t.emoji} победи: {stats.todayWins[t.id]} днес / {stats.allTimeWins[t.id]} общо · 👥 {stats.members[t.id]}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Събития на живо</h2>
        <div className="log">
          {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : 'Още няма събития.'}
        </div>
      </div>
    </main>
  );
}
