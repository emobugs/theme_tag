import assert from 'node:assert/strict';
import { Room } from '../shared/room';
import type { Viewer } from '../shared/events';
import type { PlatformSink } from '../bridge/types';
import { handleTwitchMessage, parseIrc } from '../bridge/twitch';
import { amountToUsd, dispatchYtItem, liveUrlFor, parseChatPage, parseChatResponse, parseLivePage } from '../bridge/youtube';

// Тестове на парсерите за Twitch и YouTube с примерни съобщения, без мрежа.
// npm run test:adapters

type Call = [string, ...unknown[]];
function recorder() {
  const calls: Call[] = [];
  const sink: PlatformSink = {
    chat: (u: Viewer, t: string) => calls.push(['chat', u.name, t]),
    gift: (u: Viewer, c: number, n: number, g: string) => calls.push(['gift', u.name, c, n, g]),
    like: (u: Viewer, n: number) => calls.push(['like', u.name, n]),
    share: (u: Viewer) => calls.push(['share', u.name]),
    follow: (u: Viewer) => calls.push(['follow', u.name]),
    status: () => {},
  };
  return { calls, sink };
}

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('Twitch');

test('IRC парсер с тагове', () => {
  const m = parseIrc('@badge-info=;bits=100;display-name=Ivan\\sBG;user-id=42 :ivan!ivan@ivan.tmi.twitch.tv PRIVMSG #chan :Cheer100 давай 🐸')!;
  assert.equal(m.command, 'PRIVMSG');
  assert.equal(m.tags['display-name'], 'Ivan BG');
  assert.equal(m.tags.bits, '100');
  assert.equal(m.trailing, 'Cheer100 давай 🐸');
  assert.deepEqual(m.params, ['#chan']);
});

test('PING', () => {
  const m = parseIrc('PING :tmi.twitch.tv')!;
  assert.equal(m.command, 'PING');
  assert.equal(m.trailing, 'tmi.twitch.tv');
});

test('Bits: първо чат (отбор), после подарък', () => {
  const { calls, sink } = recorder();
  handleTwitchMessage(parseIrc('@bits=300;display-name=Gosho;user-id=7 :gosho!gosho@gosho.tmi.twitch.tv PRIVMSG #c :Cheer300 🔥')!, sink);
  assert.deepEqual(calls, [
    ['chat', 'Gosho', 'Cheer300 🔥'],
    ['gift', 'Gosho', 300, 1, '300 Bits'],
  ]);
});

test('абонамент Tier 1 и Prime', () => {
  const { calls, sink } = recorder();
  handleTwitchMessage(parseIrc('@msg-id=sub;msg-param-sub-plan=1000;display-name=Ani;login=ani;user-id=1 :tmi.twitch.tv USERNOTICE #c')!, sink);
  handleTwitchMessage(parseIrc('@msg-id=resub;msg-param-sub-plan=Prime;display-name=Bobi;login=bobi;user-id=2 :tmi.twitch.tv USERNOTICE #c :🐷 3 месеца')!, sink);
  assert.deepEqual(calls, [
    ['gift', 'Ani', 500, 1, 'Абонамент'],
    ['chat', 'Bobi', '🐷 3 месеца'],
    ['gift', 'Bobi', 500, 1, 'Prime абонамент'],
  ]);
});

test('масово подаряване не се брои двойно', () => {
  const { calls, sink } = recorder();
  handleTwitchMessage(parseIrc('@msg-id=submysterygift;msg-param-mass-gift-count=2;msg-param-sub-plan=1000;display-name=Rich;user-id=9 :tmi.twitch.tv USERNOTICE #c')!, sink);
  handleTwitchMessage(parseIrc('@msg-id=subgift;msg-param-sub-plan=1000;display-name=Rich;user-id=9 :tmi.twitch.tv USERNOTICE #c')!, sink);
  handleTwitchMessage(parseIrc('@msg-id=subgift;msg-param-sub-plan=1000;display-name=Rich;user-id=9 :tmi.twitch.tv USERNOTICE #c')!, sink);
  assert.equal(calls.filter((c) => c[0] === 'gift').length, 2);
});

test('рейд', () => {
  const { calls, sink } = recorder();
  handleTwitchMessage(parseIrc('@msg-id=raid;msg-param-displayName=Streamer;msg-param-login=streamer;msg-param-viewerCount=25;user-id=5 :tmi.twitch.tv USERNOTICE #c')!, sink);
  assert.deepEqual(calls, [['gift', 'Streamer', 300, 1, 'Рейд с 25 зрители']]);
});

console.log('YouTube');

test('адреси', () => {
  assert.equal(liveUrlFor('@DigitalEffect').url, 'https://www.youtube.com/@DigitalEffect/live');
  assert.equal(liveUrlFor('https://www.youtube.com/@DigitalEffect').url, 'https://www.youtube.com/@DigitalEffect/live');
  assert.equal(liveUrlFor('https://www.youtube.com/watch?v=jfKfPfyJRdk').videoId, 'jfKfPfyJRdk');
  assert.equal(liveUrlFor('https://youtube.com/live/jfKfPfyJRdk?feature=share').videoId, 'jfKfPfyJRdk');
  assert.equal(liveUrlFor('UCSJ4gkVC6NrvII8umztf0Ow').url, 'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/live');
});

test('валути', () => {
  assert.equal(amountToUsd('$5.00'), 5);
  assert.equal(Math.round(amountToUsd('€2.00')! * 100), 216);
  assert.equal(Math.round(amountToUsd('BGN 10.00')! * 100), 550);
  assert.equal(Math.round(amountToUsd('CA$5.00')! * 100), 365);
  assert.equal(Math.round(amountToUsd('1.234,50 €')! * 100), 133326);
  assert.equal(amountToUsd('XYZ 5'), null);
});

test('страница /live: на живо и не на живо', () => {
  const live = '<link rel="canonical" href="https://www.youtube.com/watch?v=abcdefghijk"> ... "isLiveNow":true';
  assert.deepEqual(parseLivePage(live), { videoId: 'abcdefghijk', live: true });
  const off = '<link rel="canonical" href="https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx">';
  assert.deepEqual(parseLivePage(off), { videoId: null, live: false });
});

test('live_chat страница: избира "Live chat", не "Top chat"', () => {
  const html =
    '"INNERTUBE_API_KEY":"KEY123","INNERTUBE_CLIENT_VERSION":"2.20251030.01.00",' +
    '"subMenuItems":[{"title":"Top chat","selected":true,"continuation":{"reloadContinuationData":{"continuation":"TOP"}}},' +
    '{"title":"Live chat","selected":false,"continuation":{"reloadContinuationData":{"continuation":"ALL"}}}]';
  assert.deepEqual(parseChatPage(html), { apiKey: 'KEY123', clientVersion: '2.20251030.01.00', continuation: 'ALL' });
});

const author = (name: string) => ({
  authorName: { simpleText: `@${name}` },
  authorExternalChannelId: `UC_${name}`,
  authorPhoto: { thumbnails: [{ url: 'a32' }, { url: 'a64' }] },
  timestampUsec: String(Date.now() * 1000),
});

const response = {
  continuationContents: {
    liveChatContinuation: {
      continuations: [{ invalidationContinuationData: { continuation: 'NEXT', timeoutMs: 5000 } }],
      actions: [
        { addChatItemAction: { item: { liveChatTextMessageRenderer: { id: '1', ...author('mira'), message: { runs: [{ text: 'аз съм ' }, { emoji: { emojiId: '🐸', shortcuts: [':frog:'] } }] } } } } },
        { addChatItemAction: { item: { liveChatPaidMessageRenderer: { id: '2', ...author('tony'), purchaseAmountText: { simpleText: '€5.00' }, message: { runs: [{ text: '💀 бомба' }] } } } } },
        { addChatItemAction: { item: { liveChatPaidStickerRenderer: { id: '3', ...author('vik'), purchaseAmountText: { simpleText: '$2.00' } } } } },
        { addChatItemAction: { item: { liveChatMembershipItemRenderer: { id: '4', ...author('dani') } } } },
        {
          addChatItemAction: {
            item: {
              liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
                id: '5',
                authorExternalChannelId: 'UC_boss',
                header: { liveChatSponsorshipsHeaderRenderer: { ...author('boss'), primaryText: { runs: [{ text: 'Gifted ' }, { text: '5' }, { text: ' memberships' }] } } },
              },
            },
          },
        },
        { markChatItemAsDeletedAction: {} },
      ],
    },
  },
};

test('get_live_chat отговор', () => {
  const r = parseChatResponse(response);
  assert.equal(r.continuation, 'NEXT');
  assert.equal(r.timeoutMs, 5000);
  assert.deepEqual(
    r.items.map((i) => i.kind),
    ['text', 'superchat', 'sticker', 'member', 'giftmembers'],
  );
  const text = r.items[0];
  assert.equal(text.kind === 'text' && text.text, 'аз съм 🐸');
  assert.equal(text.author.name, 'mira');
  assert.equal(text.author.avatar, 'a64');
});

test('YouTube събития → играта', () => {
  const { calls, sink } = recorder();
  for (const it of parseChatResponse(response).items) dispatchYtItem(it, sink);
  assert.deepEqual(calls, [
    ['chat', 'mira', 'аз съм 🐸'],
    ['chat', 'tony', '💀 бомба'],
    ['gift', 'tony', 540, 1, 'Super Chat €5.00'],
    ['gift', 'vik', 200, 1, 'Super Sticker $2.00'],
    ['gift', 'dani', 500, 1, 'Членство'],
    ['gift', 'boss', 500, 5, 'Подарени членства'],
  ]);
});

test('край на лайфа: няма продължение', () => {
  assert.equal(parseChatResponse({ continuationContents: { liveChatContinuation: { continuations: [{}] } } }).continuation, null);
  assert.equal(parseChatResponse({}).continuation, null);
});

console.log('Връзка с играта');

test('чат с емоджи слага YouTube зрителя в отбор, Super Chat отива за него', () => {
  const room = new Room();
  const ev1 = room.chat({ id: 'youtube:UC_mira', name: 'mira' }, 'аз съм 🐸');
  assert.equal(ev1[0]?.kind === 'join' && ev1[0].team, 'frog');
  const ev2 = room.gift({ id: 'youtube:UC_mira', name: 'mira' }, 540, 1, 'Super Chat');
  assert.equal(ev2[0]?.kind === 'gift' && ev2[0].team, 'frog');
});

console.log(`\n${passed} теста минаха`);
