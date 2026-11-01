import { PLATFORMS, USD_RATES } from '../shared/config';
import type { Viewer } from '../shared/events';
import { sleep, type Adapter, type PlatformSink } from './types';

// YouTube чат без API ключ: чете същия вътрешен endpoint, който ползва чатът в браузъра.
// Официалното YouTube Data API има дневна квота, която при 24/7 лайф свършва за часове.
// Минус: при промяна от YouTube парсерът може да спре и трябва да се обнови.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'user-agent': UA,
  'accept-language': 'en-US,en;q=0.9',
  // без това в ЕС YouTube връща страница за бисквитки вместо видеото
  cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+000; SOCS=CAI',
};

// ---------- чисти функции (тестват се без мрежа) ----------

/** Приема @handle, линк към канал, UC... ID, линк към видео или 11-символно ID на видео. */
export function liveUrlFor(input: string): { videoId?: string; url: string } {
  const s = input.trim();
  const v = s.match(/(?:v=|youtu\.be\/|\/live\/)([\w-]{11})/);
  if (v) return { videoId: v[1], url: `https://www.youtube.com/watch?v=${v[1]}` };
  if (/^[\w-]{11}$/.test(s) && !s.startsWith('UC')) return { videoId: s, url: `https://www.youtube.com/watch?v=${s}` };
  const ch = s.match(/(UC[\w-]{22})/);
  if (ch) return { url: `https://www.youtube.com/channel/${ch[1]}/live` };
  const handle = s.match(/@([\w.-]+)/)?.[1] ?? s.replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/\/.*$/, '');
  return { url: `https://www.youtube.com/@${handle}/live` };
}

/** От страницата /live или /watch: ID на видеото, ако в момента има лайф. */
export function parseLivePage(html: string): { videoId: string | null; live: boolean } {
  const id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1] ?? null;
  const live = /"isLiveNow"\s*:\s*true/.test(html) || /"isLive"\s*:\s*true/.test(html);
  return { videoId: id, live: Boolean(id) && live };
}

/** От /live_chat страницата: ключ, версия на клиента и продължение за режим "Live chat" (всички съобщения). */
export function parseChatPage(html: string): { apiKey: string | null; clientVersion: string; continuation: string | null } {
  const apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  const clientVersion =
    html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([\d.]+)"/)?.[1] ?? html.match(/"clientVersion"\s*:\s*"([\d.]+)"/)?.[1] ?? '2.20250101.00.00';
  // "Top chat" филтрира кратки съобщения (точно емоджитата, с които се влиза в отбор),
  // затова търсим продължението за "Live chat".
  let continuation: string | null = null;
  const liveIdx = html.indexOf('"title":"Live chat"');
  if (liveIdx !== -1) continuation = html.slice(liveIdx, liveIdx + 3000).match(/"continuation"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  continuation ??= html.match(/"continuation"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  return { apiKey, clientVersion, continuation };
}

/** "$5.00", "€2.00", "BGN 10.00", "CA$5.00", "1.234,56 €" → долари */
export function amountToUsd(text: string): number | null {
  const raw = text.replace(/ /g, ' ').trim();
  const numMatch = raw.match(/[\d][\d.,\s]*/);
  if (!numMatch) return null;
  let num = numMatch[0].replace(/\s/g, '');
  // десетичният знак е последният от . или , с 1-2 цифри след него
  const dec = num.match(/[.,](\d{1,2})$/);
  num = dec ? num.slice(0, -dec[0].length).replace(/[.,]/g, '') + '.' + dec[1] : num.replace(/[.,]/g, '');
  const value = Number(num);
  if (!Number.isFinite(value)) return null;
  const cur = raw.replace(numMatch[0], '').trim();
  const symbols: Record<string, string> = {
    $: 'USD', US$: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', CA$: 'CAD', A$: 'AUD', NZ$: 'NZD', R$: 'BRL',
    MX$: 'MXN', HK$: 'HKD', NT$: 'TWD', '₩': 'KRW', '₱': 'PHP', '₪': 'ILS', '₫': 'VND', '₺': 'TRY', 'zł': 'PLN', 'лв': 'BGN', 'лв.': 'BGN',
  };
  const code = symbols[cur] ?? cur.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  const rate = USD_RATES[code];
  if (!rate) return null;
  return value * rate;
}

export type YtItem =
  | { kind: 'text'; id: string; ts: number; author: Viewer; text: string }
  | { kind: 'superchat' | 'sticker'; id: string; ts: number; author: Viewer; text: string; amount: string }
  | { kind: 'member'; id: string; ts: number; author: Viewer }
  | { kind: 'giftmembers'; id: string; ts: number; author: Viewer; count: number };

/* eslint-disable @typescript-eslint/no-explicit-any */
function runsText(runs: any[] | undefined): string {
  if (!Array.isArray(runs)) return '';
  return runs
    .map((r) => {
      if (typeof r.text === 'string') return r.text;
      const e = r.emoji;
      if (!e) return '';
      return e.isCustomEmoji ? (e.shortcuts?.[0] ?? '') : (e.emojiId ?? e.shortcuts?.[0] ?? '');
    })
    .join('');
}

function authorOf(r: any): Viewer {
  const thumbs = r.authorPhoto?.thumbnails;
  return {
    id: String(r.authorExternalChannelId ?? r.authorName?.simpleText ?? 'yt'),
    name: String(r.authorName?.simpleText ?? 'зрител').replace(/^@/, '').slice(0, 24),
    avatar: Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1].url : undefined,
  };
}

export function parseChatResponse(json: any): { items: YtItem[]; continuation: string | null; timeoutMs: number } {
  const lc = json?.continuationContents?.liveChatContinuation;
  if (!lc) return { items: [], continuation: null, timeoutMs: 0 };
  const c = lc.continuations?.[0] ?? {};
  const cont = c.invalidationContinuationData ?? c.timedContinuationData ?? c.reloadContinuationData ?? c.liveChatReplayContinuationData;
  const items: YtItem[] = [];
  for (const action of lc.actions ?? []) {
    const item = action.addChatItemAction?.item;
    if (!item) continue;
    const ts = (r: any) => Math.floor(Number(r.timestampUsec ?? 0) / 1000);
    if (item.liveChatTextMessageRenderer) {
      const r = item.liveChatTextMessageRenderer;
      items.push({ kind: 'text', id: r.id, ts: ts(r), author: authorOf(r), text: runsText(r.message?.runs) });
    } else if (item.liveChatPaidMessageRenderer) {
      const r = item.liveChatPaidMessageRenderer;
      items.push({ kind: 'superchat', id: r.id, ts: ts(r), author: authorOf(r), text: runsText(r.message?.runs), amount: r.purchaseAmountText?.simpleText ?? '' });
    } else if (item.liveChatPaidStickerRenderer) {
      const r = item.liveChatPaidStickerRenderer;
      items.push({ kind: 'sticker', id: r.id, ts: ts(r), author: authorOf(r), text: '', amount: r.purchaseAmountText?.simpleText ?? '' });
    } else if (item.liveChatMembershipItemRenderer) {
      const r = item.liveChatMembershipItemRenderer;
      items.push({ kind: 'member', id: r.id, ts: ts(r), author: authorOf(r) });
    } else if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer) {
      const r = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
      const h = r.header?.liveChatSponsorshipsHeaderRenderer ?? {};
      const count = Number(runsText(h.primaryText?.runs).match(/\d+/)?.[0] ?? 1);
      items.push({ kind: 'giftmembers', id: r.id, ts: ts(r), author: authorOf({ ...h, authorExternalChannelId: r.authorExternalChannelId }), count });
    }
  }
  return { items, continuation: cont?.continuation ?? null, timeoutMs: Number(cont?.timeoutMs ?? 2000) };
}

/** Превежда едно съобщение от YouTube към събития в играта. */
export function dispatchYtItem(it: YtItem, sink: PlatformSink) {
  const cfg = PLATFORMS.youtube;
  switch (it.kind) {
    case 'text':
      if (it.text) sink.chat(it.author, it.text);
      break;
    case 'superchat':
    case 'sticker': {
      if (it.text) sink.chat(it.author, it.text);
      const usd = amountToUsd(it.amount);
      if (usd === null) {
        console.warn(`[youtube] непозната валута: "${it.amount}", броя го като $1`);
      }
      const coins = Math.max(1, Math.round((usd ?? 1) * cfg.coinsPerUsd));
      sink.gift(it.author, coins, 1, `${it.kind === 'superchat' ? 'Super Chat' : 'Super Sticker'} ${it.amount}`);
      break;
    }
    case 'member':
      sink.gift(it.author, cfg.memberCoins, 1, 'Членство');
      break;
    case 'giftmembers':
      sink.gift(it.author, cfg.memberCoins, Math.max(1, it.count), 'Подарени членства');
      break;
  }
}

// ---------- мрежа ----------

async function getText(url: string) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} за ${url}`);
  return res.text();
}

export function startYouTube(input: string, sink: PlatformSink): Adapter {
  let stopped = false;
  const target = liveUrlFor(input);
  const seen = new Set<string>();

  const loop = async () => {
    while (!stopped) {
      try {
        sink.status(`търся лайф: ${input}`, false);
        let videoId = target.videoId ?? null;
        if (!videoId) {
          const page = parseLivePage(await getText(`${target.url}?hl=en&gl=US`));
          videoId = page.live ? page.videoId : null;
        }
        if (!videoId) {
          sink.status(`${input} не е на живо, проверявам пак след 30с`, false);
          await sleep(30_000);
          continue;
        }

        const chat = parseChatPage(await getText(`https://www.youtube.com/live_chat?is_popout=1&v=${videoId}&hl=en&gl=US`));
        if (!chat.continuation) throw new Error('чатът е изключен или лайфът не е започнал');
        let continuation: string | null = chat.continuation;
        const startedAt = Date.now() - 10_000; // пропуска историята отпреди свързването
        sink.status(`на живо: youtube.com/watch?v=${videoId}`, true);

        const endpoint = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false${chat.apiKey ? `&key=${chat.apiKey}` : ''}`;
        let fails = 0;
        while (!stopped && continuation) {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { ...HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({
              context: { client: { clientName: 'WEB', clientVersion: chat.clientVersion, hl: 'en', gl: 'US' } },
              continuation,
            }),
          });
          if (!res.ok) {
            if (++fails >= 5) throw new Error(`get_live_chat HTTP ${res.status}`);
            await sleep(3000);
            continue;
          }
          fails = 0;
          const parsed = parseChatResponse(await res.json());
          for (const it of parsed.items) {
            if (seen.has(it.id) || (it.ts && it.ts < startedAt)) continue;
            seen.add(it.id);
            dispatchYtItem(it, sink);
          }
          if (seen.size > 5000) seen.clear();
          continuation = parsed.continuation;
          const wait = Math.min(PLATFORMS.youtube.maxPollMs, Math.max(PLATFORMS.youtube.minPollMs, parsed.timeoutMs || 2000));
          await sleep(wait);
        }
        if (!stopped) sink.status('YouTube лайфът приключи, търся нов', false);
      } catch (err) {
        sink.status(`YouTube: ${String((err as Error)?.message ?? err).slice(0, 160)}`, false);
      }
      if (!stopped) await sleep(20_000);
    }
  };
  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}
