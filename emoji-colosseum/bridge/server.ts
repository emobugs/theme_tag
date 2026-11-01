import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { BRIDGE, PLATFORMS, TEAM_BY_ID, type Platform, type TeamId } from '../shared/config';
import type { BridgeStatus, ClientMsg, InjectMsg, LiveEvent, ServerMsg, Viewer } from '../shared/events';
import { Room } from '../shared/room';
import { Simulator } from '../shared/sim';
import { createSaver, loadState } from './store';
import { startTikTok } from './tiktok';
import { startTwitch } from './twitch';
import type { Adapter, PlatformSink } from './types';
import { startYouTube } from './youtube';

// Bridge: TikTok / Twitch / YouTube -> нормализирани събития -> WebSocket към overlay-а.
// Може да чете и трите платформи наведнъж (мултистрийм в една арена).
// Държи отборите и класациите, за да не се губят при презареждане на overlay-а.

// 24/7 процес: една неочаквана грешка не бива да спира играта.
process.on('unhandledRejection', (err) => console.error('[bridge] необработена грешка (продължавам):', err));
process.on('uncaughtException', (err) => console.error('[bridge] неочаквана грешка (продължавам):', err));

const hasEnv = existsSync('.env');
if (hasEnv) {
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    console.warn('[bridge] .env не можа да се прочете:', (err as Error).message);
  }
}

const argv = new Set(process.argv.slice(2));
const PORT = Number(process.env.BRIDGE_PORT || BRIDGE.defaultPort);
const MODE = argv.has('--sim') ? 'sim' : (process.env.MODE || 'auto');
const DATA_FILE = resolve(process.env.DATA_FILE || 'data/stats.json');
const CONFIG: Record<Platform, string> = {
  tiktok: (process.env.TIKTOK_USERNAME ?? '').replace(/^@/, '').trim(),
  twitch: (process.env.TWITCH_CHANNEL ?? '').trim(),
  youtube: (process.env.YOUTUBE_CHANNEL ?? '').trim(),
};
const LABEL: Record<Platform, string> = { tiktok: 'TikTok', twitch: 'Twitch', youtube: 'YouTube' };

const room = new Room(loadState(DATA_FILE), () => {
  saver.schedule();
  statsDirty = true;
});
const saver = createSaver(DATA_FILE, () => room.state);
let statsDirty = true;

interface Client {
  ws: WebSocket;
  role: 'overlay' | 'control' | 'unknown';
}
const clients = new Set<Client>();
let primary: Client | null = null;

function send(c: Client, msg: ServerMsg) {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMsg) {
  const raw = JSON.stringify(msg);
  for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
}

function emit(events: LiveEvent[]) {
  for (const e of events) broadcast({ t: 'event', e });
}

// Само един overlay ("primary") докладва края на рундовете, за да не се броят двойно
// победите, когато overlay-ът е отворен и в OBS, и в браузъра.
function electPrimary() {
  if (primary && clients.has(primary)) return;
  primary = [...clients].find((c) => c.role === 'overlay') ?? null;
  if (primary) send(primary, { t: 'primary', primary: true });
}

// ---------- статус ----------

const platformStatus = new Map<Platform, { text: string; ok: boolean }>();
const sim = new Simulator(
  {
    chat: (u, t) => emit(room.chat(u, t)),
    gift: (u, c, n, g) => emit(room.gift(u, c, n, g)),
    like: (u, n) => emit(room.like(u, n)),
    share: (u) => emit(room.share(u)),
    follow: (u) => emit(room.follow(u)),
  },
  1,
);

function currentStatus(): BridgeStatus {
  const platforms = [...platformStatus.keys()];
  const parts = platforms.map((p) => `${platformStatus.get(p)!.ok ? '✓' : '…'} ${LABEL[p]}: ${platformStatus.get(p)!.text}`);
  if (sim.running) parts.push('симулатор');
  return {
    source: platforms.length ? 'live' : 'sim',
    platforms,
    status: parts.join(' · ') || 'без източник',
    sim: sim.running,
  };
}

function pushStatus() {
  broadcast({ t: 'status', ...currentStatus() });
}

// ---------- платформи ----------

function sinkFor(p: Platform): PlatformSink {
  const id = (u: Viewer): Viewer => ({ ...u, id: `${p}:${u.id}` });
  const chatLikes = p === 'tiktok' ? 0 : PLATFORMS[p].chatLikes;
  return {
    chat: (u, text) => {
      const events = room.chat(id(u), text);
      emit(events);
      // Twitch и YouTube нямат лайкове: всяко съобщение в чата лекува отбора на зрителя
      if (!events.length && chatLikes) emit(room.like(id(u), chatLikes));
    },
    gift: (u, coins, count, name, image) => emit(room.gift(id(u), coins, count, name, image)),
    like: (u, n) => emit(room.like(id(u), n)),
    share: (u) => emit(room.share(id(u))),
    follow: (u) => emit(room.follow(id(u))),
    status: (text, ok) => {
      const prev = platformStatus.get(p);
      platformStatus.set(p, { text, ok });
      if (prev?.text !== text) console.log(`[${p}] ${text}`);
      pushStatus();
    },
  };
}

const adapters: Adapter[] = [];
if (MODE !== 'sim') {
  if (CONFIG.tiktok) adapters.push(startTikTok(CONFIG.tiktok, sinkFor('tiktok'), process.env.EULER_API_KEY || undefined));
  if (CONFIG.twitch) adapters.push(startTwitch(CONFIG.twitch, sinkFor('twitch')));
  if (CONFIG.youtube) adapters.push(startYouTube(CONFIG.youtube, sinkFor('youtube')));
}
if (!adapters.length) {
  if (MODE !== 'sim') {
    console.log('[bridge] няма зададена платформа (TIKTOK_USERNAME, TWITCH_CHANNEL или YOUTUBE_CHANNEL в .env). Пускам симулатор.');
  }
  sim.start();
}

// ---------- инжектиране от контролния панел ----------

function injectViewer(name: string): Viewer {
  const clean = name.trim().slice(0, 24) || 'тест';
  return { id: `ctl_${clean.toLowerCase()}`, name: clean };
}

function inject(e: InjectMsg) {
  const u = injectViewer(e.name);
  switch (e.kind) {
    case 'chat':
      return emit(room.chat(u, e.text));
    case 'gift': {
      const team: TeamId | undefined = e.team && TEAM_BY_ID[e.team] ? e.team : undefined;
      const coins = Math.max(1, Math.floor(e.coins));
      const count = Math.min(999, Math.max(1, Math.floor(e.count)));
      return emit(room.gift(u, coins, count, e.giftName ?? `${coins} монети`, undefined, team));
    }
    case 'like':
      return emit(room.like(u, Math.max(1, Math.floor(e.count))));
    case 'share':
      return emit(room.share(u));
    case 'follow':
      return emit(room.follow(u));
  }
}

// ---------- WebSocket ----------

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, ...currentStatus(), clients: clients.size }));
    return;
  }
  res.writeHead(404).end();
});

http.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[bridge] Порт ${PORT} е зает от друга програма (често втори пуснат bridge или Cloudflare wrangler).`);
    console.error('[bridge] Затвори другия процес или сложи BRIDGE_PORT=8788 в .env и отвори overlay-а с ?ws=ws://localhost:8788\n');
  } else {
    console.error('[bridge] сървърът не може да стартира:', err);
  }
  process.exit(1);
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws) => {
  const c: Client = { ws, role: 'unknown' };
  clients.add(c);

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (msg.t) {
      case 'role':
        c.role = msg.role === 'control' ? 'control' : 'overlay';
        electPrimary();
        send(c, { t: 'hello', primary: c === primary, ...currentStatus() });
        send(c, { t: 'stats', s: room.snapshot() });
        break;
      case 'inject':
        if (c.role === 'control') inject(msg.e);
        break;
      case 'sim':
        if (c.role !== 'control') break;
        if (msg.on) sim.start();
        else sim.stop();
        pushStatus();
        break;
      case 'roundStart':
        if (c === primary) room.roundStart();
        break;
      case 'roundEnd':
        if (c === primary) {
          room.roundEnd(msg.winner, msg.reason, msg.by);
          const w = msg.winner ? TEAM_BY_ID[msg.winner] : null;
          console.log(`[round] край (${msg.reason}): ${w ? `${w.emoji} ${w.name}` : 'няма победител'}`);
        }
        break;
    }
  });

  ws.on('error', () => ws.close());
  ws.on('close', () => {
    clients.delete(c);
    if (primary === c) {
      primary = null;
      electPrimary();
    }
  });
});

// класациите се пращат най-много 2 пъти в секунда
setInterval(() => {
  if (!statsDirty) return;
  statsDirty = false;
  broadcast({ t: 'stats', s: room.snapshot() });
}, 500);

http.listen(PORT, () => {
  const on = (Object.keys(CONFIG) as Platform[]).filter((p) => CONFIG[p] && MODE !== 'sim');
  console.log('');
  console.log(`[bridge] ✓ работи на ws://localhost:${PORT}   (проверка: http://localhost:${PORT}/health)`);
  console.log(`[bridge] .env: ${hasEnv ? 'намерен' : 'НЯМА (ползвам само системните променливи)'}`);
  console.log(`[bridge] платформи: ${on.length ? on.map((p) => `${LABEL[p]} (${CONFIG[p]})`).join(', ') : 'няма, симулатор'}`);
  console.log(`[bridge] данни: ${DATA_FILE}`);
  console.log('');
});

const shutdown = async () => {
  console.log('[bridge] спиране...');
  sim.stop();
  await Promise.allSettled(adapters.map((a) => a.stop()));
  saver.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
