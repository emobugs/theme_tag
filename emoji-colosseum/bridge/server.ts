import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { BRIDGE, TEAM_BY_ID, type TeamId } from '../shared/config';
import type { ClientMsg, InjectMsg, LiveEvent, ServerMsg, SourceKind, Viewer } from '../shared/events';
import { Room } from '../shared/room';
import { Simulator } from '../shared/sim';
import { createSaver, loadState } from './store';
import { startTikTok } from './tiktok';

// Bridge: TikTok LIVE -> нормализирани събития -> WebSocket към overlay-а.
// Държи отборите и класациите, за да не се губят при презареждане на overlay-а.

try {
  process.loadEnvFile('.env');
} catch {
  /* няма .env, ползваме само process.env */
}

const argv = new Set(process.argv.slice(2));
const PORT = Number(process.env.BRIDGE_PORT ?? BRIDGE.defaultPort);
const USERNAME = (process.env.TIKTOK_USERNAME ?? '').replace(/^@/, '').trim();
const MODE = argv.has('--sim') ? 'sim' : (process.env.MODE ?? 'auto');
const DATA_FILE = resolve(process.env.DATA_FILE ?? 'data/stats.json');

const room = new Room(loadState(DATA_FILE), () => {
  saver.schedule();
  statsDirty = true;
});
const saver = createSaver(DATA_FILE, () => room.state);

let source: SourceKind = 'sim';
let statusText = 'стартиране';
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

// ---------- източници ----------

const sink = {
  chat: (u: Viewer, text: string) => emit(room.chat(u, text)),
  gift: (u: Viewer, coins: number, count: number, name: string, image?: string, team?: TeamId) =>
    emit(room.gift(u, coins, count, name, image, team)),
  like: (u: Viewer, count: number) => emit(room.like(u, count)),
  share: (u: Viewer) => emit(room.share(u)),
  follow: (u: Viewer) => emit(room.follow(u)),
};

const sim = new Simulator(sink, 1);

function setStatus(text: string) {
  statusText = text;
  console.log(`[bridge] ${text}`);
  broadcast({ t: 'status', source, status: text, sim: sim.running });
}

let tiktok: { stop(): Promise<void> } | null = null;

if (MODE !== 'sim' && USERNAME) {
  source = 'tiktok';
  tiktok = startTikTok(
    USERNAME,
    {
      ...sink,
      status: (text) => setStatus(text),
    },
    process.env.EULER_API_KEY || undefined,
  );
} else {
  if (MODE === 'tiktok') console.warn('[bridge] MODE=tiktok, но TIKTOK_USERNAME е празно. Пускам симулатор.');
  source = 'sim';
  sim.start();
  setStatus('симулатор (без TikTok)');
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
      return sink.chat(u, e.text);
    case 'gift': {
      const team = e.team && TEAM_BY_ID[e.team] ? e.team : undefined;
      const coins = Math.max(1, Math.floor(e.coins));
      const count = Math.min(999, Math.max(1, Math.floor(e.count)));
      return sink.gift(u, coins, count, e.giftName ?? `${coins} монети`, undefined, team);
    }
    case 'like':
      return sink.like(u, Math.max(1, Math.floor(e.count)));
    case 'share':
      return sink.share(u);
    case 'follow':
      return sink.follow(u);
  }
}

// ---------- WebSocket ----------

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, source, status: statusText, clients: clients.size, sim: sim.running }));
    return;
  }
  res.writeHead(404).end();
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
        send(c, { t: 'hello', primary: c === primary, source, status: statusText, sim: sim.running });
        send(c, { t: 'stats', s: room.snapshot() });
        break;
      case 'inject':
        if (c.role === 'control') inject(msg.e);
        break;
      case 'sim':
        if (c.role !== 'control') break;
        if (msg.on) sim.start();
        else sim.stop();
        setStatus(statusText);
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
  console.log(`[bridge] WebSocket на ws://localhost:${PORT}  (health: http://localhost:${PORT}/health)`);
  console.log(`[bridge] данни: ${DATA_FILE}`);
});

const shutdown = async () => {
  console.log('[bridge] спиране...');
  sim.stop();
  await tiktok?.stop();
  saver.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
