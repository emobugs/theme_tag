import WebSocket from 'ws';
import { PLATFORMS } from '../shared/config';
import type { Viewer } from '../shared/events';
import { sleep, type Adapter, type PlatformSink } from './types';

// Twitch чат през официалния IRC WebSocket, анонимно (justinfan): не трябва акаунт,
// парола или API ключ. Bits, абонаментите и рейдовете идват в същия поток като чата.

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

export interface IrcMsg {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
  trailing: string;
}

function unescapeTag(v: string) {
  return v.replace(/\\(.)/g, (_, c: string) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' })[c] ?? c);
}

export function parseIrc(line: string): IrcMsg | null {
  let rest = line.trim();
  if (!rest) return null;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    for (const pair of rest.slice(1, sp).split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) tags[pair] = '';
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let trailing = '';
  const t = rest.indexOf(' :');
  if (t !== -1) {
    trailing = rest.slice(t + 2);
    rest = rest.slice(0, t);
  }
  const [command, ...params] = rest.split(' ').filter(Boolean);
  return { tags, prefix, command, params, trailing };
}

function viewerFrom(m: IrcMsg): Viewer {
  const login = m.tags.login || m.prefix.split('!')[0] || 'зрител';
  return { id: m.tags['user-id'] || login, name: (m.tags['display-name'] || login).slice(0, 24) };
}

/** Превежда едно IRC съобщение към събития. Изнесено отделно, за да се тества без мрежа. */
export function handleTwitchMessage(m: IrcMsg, sink: PlatformSink) {
  const cfg = PLATFORMS.twitch;
  if (m.command === 'PRIVMSG') {
    const user = viewerFrom(m);
    let text = m.trailing;
    if (text.startsWith('\u0001ACTION ')) text = text.slice(8, -1);
    // първо чатът: ако зрителят пише 🐸 заедно с Bits, Bits-овете отиват за жабата
    sink.chat(user, text);
    const bits = Number(m.tags.bits ?? 0);
    if (bits > 0) sink.gift(user, Math.round(bits * cfg.bitsToCoins), 1, `${bits} Bits`);
    return;
  }
  if (m.command === 'USERNOTICE') {
    const kind = m.tags['msg-id'];
    const user = viewerFrom(m);
    const plan = m.tags['msg-param-sub-plan'] ?? '1000';
    const subCoins = cfg.subCoins[plan] ?? cfg.subCoins['1000'];
    switch (kind) {
      case 'sub':
      case 'resub':
        if (m.trailing) sink.chat(user, m.trailing);
        sink.gift(user, subCoins, 1, plan === 'Prime' ? 'Prime абонамент' : 'Абонамент');
        break;
      case 'subgift':
        sink.gift(user, subCoins, 1, 'Подарен абонамент');
        break;
      case 'anonsubgift':
        sink.gift({ id: 'anonymous', name: 'Анонимен' }, subCoins, 1, 'Подарен абонамент');
        break;
      // submysterygift идва преди поредица от subgift съобщения (по едно на получател),
      // затова тук не се брои, за да не се удвои.
      case 'raid': {
        const raider: Viewer = {
          id: m.tags['user-id'] || m.tags['msg-param-login'] || 'raid',
          name: (m.tags['msg-param-displayName'] || m.tags['display-name'] || 'рейд').slice(0, 24),
        };
        const viewers = Number(m.tags['msg-param-viewerCount'] ?? 0);
        sink.gift(raider, cfg.raidCoins, 1, `Рейд с ${viewers} зрители`);
        break;
      }
    }
  }
}

export function startTwitch(channelInput: string, sink: PlatformSink): Adapter {
  const channel = channelInput
    .trim()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '')
    .replace(/^#/, '')
    .split(/[/?]/)[0]
    .toLowerCase();
  let stopped = false;
  let ws: WebSocket | null = null;

  const runOnce = () =>
    new Promise<void>((resolve) => {
      const nick = `justinfan${10000 + Math.floor(Math.random() * 80000)}`;
      ws = new WebSocket(IRC_URL);
      let alive = Date.now();
      const watchdog = setInterval(() => {
        // Twitch праща PING на ~5 мин. Ако 7 мин няма нищо, връзката е мъртва.
        if (Date.now() - alive > 7 * 60_000) ws?.terminate();
        else if (ws?.readyState === WebSocket.OPEN) ws.send('PING :keepalive');
      }, 60_000);

      ws.on('open', () => {
        ws!.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws!.send('PASS SCHMOOPIIE');
        ws!.send(`NICK ${nick}`);
        ws!.send(`JOIN #${channel}`);
      });
      ws.on('message', (raw) => {
        alive = Date.now();
        for (const line of String(raw).split('\r\n')) {
          const m = parseIrc(line);
          if (!m) continue;
          if (m.command === 'PING') ws!.send(`PONG :${m.trailing || 'tmi.twitch.tv'}`);
          else if (m.command === 'RECONNECT') ws!.close();
          else if (m.command === 'ROOMSTATE') sink.status(`чат на twitch.tv/${channel}`, true);
          else if (m.command === 'NOTICE') sink.status(`Twitch: ${m.trailing}`, false);
          else handleTwitchMessage(m, sink);
        }
      });
      ws.on('error', (err) => sink.status(`Twitch грешка: ${err.message}`, false));
      ws.on('close', () => {
        clearInterval(watchdog);
        resolve();
      });
    });

  const loop = async () => {
    let backoff = 2000;
    while (!stopped) {
      sink.status(`свързване с twitch.tv/${channel}...`, false);
      const started = Date.now();
      await runOnce();
      if (stopped) break;
      if (Date.now() - started > 60_000) backoff = 2000;
      sink.status(`Twitch връзката падна, нов опит след ${backoff / 1000}с`, false);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
  void loop();

  return {
    async stop() {
      stopped = true;
      ws?.close();
    },
  };
}
