import { BRIDGE } from '../shared/config';
import type { BridgeStatus, ClientMsg, LiveEvent, ServerMsg, StatsSnapshot } from '../shared/events';
import { Room, type PersistedState } from '../shared/room';
import { Simulator } from '../shared/sim';

// Източник на събития за overlay-а и контролния панел.
// online: WebSocket към bridge-а. offline: Room + симулатор в самия браузър.

export type FeedStatus = BridgeStatus & { connected: boolean };

export interface FeedHandlers {
  onEvent?: (e: LiveEvent) => void;
  onStats?: (s: StatsSnapshot) => void;
  onStatus?: (s: FeedStatus) => void;
  onPrimary?: (primary: boolean) => void;
}

export interface Feed {
  send(msg: ClientMsg): void;
  close(): void;
}

export function bridgeUrl(params: URLSearchParams): string {
  const explicit = params.get('ws');
  if (explicit) return explicit;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname || 'localhost'}:${BRIDGE.defaultPort}`;
}

export function connectBridge(url: string, role: 'overlay' | 'control', h: FeedHandlers): Feed {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 500;
      ws!.send(JSON.stringify({ t: 'role', role } satisfies ClientMsg));
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (msg.t) {
        case 'hello':
          h.onPrimary?.(msg.primary);
          h.onStatus?.({ connected: true, source: msg.source, platforms: msg.platforms ?? [], status: msg.status, sim: msg.sim });
          break;
        case 'status':
          h.onStatus?.({ connected: true, source: msg.source, platforms: msg.platforms ?? [], status: msg.status, sim: msg.sim });
          break;
        case 'primary':
          h.onPrimary?.(msg.primary);
          break;
        case 'event':
          h.onEvent?.(msg.e);
          break;
        case 'stats':
          h.onStats?.(msg.s);
          break;
      }
    };
    ws.onclose = () => {
      h.onPrimary?.(false);
      h.onStatus?.({
        connected: false,
        source: 'sim',
        platforms: [],
        status: `няма връзка с bridge (${url}). Пусни "npm run dev" и виж реда [bridge] в терминала, или отвори с ?offline=1`,
        sim: false,
      });
      if (closed) return;
      timer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 8000);
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}

const OFFLINE_KEY = 'emoji-colosseum:offline-state';

export function connectOffline(h: FeedHandlers): Feed {
  let saved: PersistedState | undefined;
  try {
    const raw = localStorage.getItem(OFFLINE_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {
    /* частен прозорец */
  }
  let dirty = true;
  const room = new Room(saved, () => {
    dirty = true;
  });
  const emit = (events: LiveEvent[]) => events.forEach((e) => h.onEvent?.(e));
  const sim = new Simulator({
    chat: (u, t) => emit(room.chat(u, t)),
    gift: (u, c, n, g) => emit(room.gift(u, c, n, g)),
    like: (u, n) => emit(room.like(u, n)),
    share: (u) => emit(room.share(u)),
    follow: (u) => emit(room.follow(u)),
  });
  sim.start();
  const statsTimer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    h.onStats?.(room.snapshot());
    try {
      localStorage.setItem(OFFLINE_KEY, JSON.stringify(room.state));
    } catch {
      /* ignore */
    }
  }, 500);
  setTimeout(() => {
    h.onPrimary?.(true);
    h.onStatus?.({ connected: true, source: 'offline', platforms: [], status: 'офлайн демо (симулатор в браузъра)', sim: true });
  }, 0);

  return {
    send(msg) {
      if (msg.t === 'roundStart') room.roundStart();
      if (msg.t === 'roundEnd') room.roundEnd(msg.winner, msg.reason, msg.by);
    },
    close() {
      sim.stop();
      clearInterval(statsTimer);
    },
  };
}
