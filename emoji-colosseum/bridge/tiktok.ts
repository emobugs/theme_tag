import { ControlEvent, SignConfig, TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';
import type { Viewer } from '../shared/events';
import { sleep, type Adapter, type PlatformSink } from './types';

// Връзка с TikTok LIVE през tiktok-live-connector (неофициална библиотека).
// Полетата се четат защитно, защото TikTok често сменя формата.

/* eslint-disable @typescript-eslint/no-explicit-any */
function viewerOf(u: any): Viewer | null {
  if (!u) return null;
  const id = String(u.userId ?? u.id ?? u.uniqueId ?? u.displayId ?? '');
  const handle = u.uniqueId ?? u.displayId ?? '';
  const name = (u.nickname || handle || 'зрител').toString().slice(0, 24);
  if (!id) return null;
  const avatar: string | undefined =
    u.profilePictureUrl ?? u.profilePicture?.urls?.[0] ?? u.avatarThumb?.urlList?.[0] ?? undefined;
  return { id, name, avatar };
}

export function startTikTok(username: string, sink: PlatformSink, apiKey?: string): Adapter {
  if (apiKey) SignConfig.apiKey = apiKey;
  let stopped = false;
  let conn: TikTokLiveConnection | null = null;
  // текущите серии подаръци: key -> последно видян repeatCount
  const streaks = new Map<string, { count: number; at: number }>();

  const wire = (c: TikTokLiveConnection) => {
    c.on(WebcastEvent.CHAT, (d: any) => {
      const v = viewerOf(d.user);
      const text = d.comment ?? d.content ?? '';
      if (v && text) sink.chat(v, String(text));
    });

    c.on(WebcastEvent.GIFT, (d: any) => {
      const v = viewerOf(d.user);
      if (!v) return;
      const g = d.giftDetails ?? {};
      const ext = d.extendedGiftInfo ?? {};
      const coins = Number(g.diamondCount ?? ext.diamond_count ?? d.diamondCount ?? 0);
      if (!coins) return;
      const name = String(g.giftName ?? g.name ?? ext.name ?? 'подарък');
      const image: string | undefined = g.giftPictureUrl ?? g.image?.urlList?.[0] ?? ext.image?.url_list?.[0];
      const type = Number(g.giftType ?? g.type ?? 0);
      const repeat = Math.max(1, Number(d.repeatCount ?? 1));
      const ended = Boolean(d.repeatEnd);

      if (type !== 1) {
        sink.gift(v, coins, repeat, name, image);
        return;
      }
      // Серия: изпращаме само разликата, за да реагира играта веднага, а не в края на серията.
      const key = `${v.id}:${d.giftId}:${d.groupId ?? ''}`;
      const prev = streaks.get(key)?.count ?? 0;
      const delta = repeat - prev;
      if (delta > 0) sink.gift(v, coins, delta, name, image);
      if (ended) streaks.delete(key);
      else streaks.set(key, { count: Math.max(prev, repeat), at: Date.now() });
    });

    c.on(WebcastEvent.LIKE, (d: any) => {
      const v = viewerOf(d.user);
      const n = Number(d.likeCount ?? d.count ?? 1);
      if (v && n > 0) sink.like(v, n);
    });

    c.on(WebcastEvent.SHARE, (d: any) => {
      const v = viewerOf(d.user);
      if (v) sink.share(v);
    });

    c.on(WebcastEvent.FOLLOW, (d: any) => {
      const v = viewerOf(d.user);
      if (v) sink.follow(v);
    });
  };

  // чисти забравени серии
  const gc = setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [k, s] of streaks) if (s.at < cutoff) streaks.delete(k);
  }, 30_000);

  const loop = async () => {
    while (!stopped) {
      try {
        conn = new TikTokLiveConnection(username, { processInitialData: false, enableExtendedGiftInfo: true });
        wire(conn);
        conn.on(ControlEvent.ERROR, (e: any) => console.warn('[tiktok]', e?.info ?? '', String(e?.exception?.message ?? e).slice(0, 200)));
        const c = conn;
        const closed = new Promise<void>((resolve) => {
          c.on(ControlEvent.DISCONNECTED, () => resolve());
          c.on(WebcastEvent.STREAM_END, () => resolve());
        });
        sink.status(`свързване с @${username}...`, false);
        const state = await conn.connect();
        sink.status(`на живо: @${username} (room ${state.roomId})`, true);
        await closed;
        sink.status('лайфът спря, чакам повторно включване', false);
      } catch (err: any) {
        const msg = String(err?.message ?? err).slice(0, 160);
        sink.status(`не е на живо или грешка: ${msg}`, false);
      }
      try {
        await conn?.disconnect();
      } catch {
        /* вече е затворена */
      }
      conn?.removeAllListeners();
      if (!stopped) await sleep(20_000);
    }
  };
  void loop();

  return {
    async stop() {
      stopped = true;
      clearInterval(gc);
      try {
        await conn?.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}
