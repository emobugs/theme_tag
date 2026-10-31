import { GAME } from '../shared/config';
import { Game } from '../game/engine';
import { Room } from '../shared/room';
import { Simulator } from '../shared/sim';

// Headless баланс: колко трае рунд без подаръци и как завършва.
// npm run tune -- 30   (30 рунда)

const rounds = Number(process.argv[2] ?? 20);
const live = process.argv.includes('--live'); // симулирани зрители и подаръци
const results: { secs: number; reason: string; alive: number }[] = [];
let fightStart = 0;

const game = new Game((n) => {
  if (n.type === 'banner' && n.title === 'БОЙ!') fightStart = game.now;
  if (n.type === 'roundEnd') {
    const alive = game.champions.filter((c) => c.alive).length;
    results.push({ secs: (game.now - fightStart) / 1000, reason: n.reason, alive });
  }
});
game.lite = true;

const room = new Room();
const feed = (events: ReturnType<Room['chat']>) => events.forEach((e) => game.apply(e));
const sim = new Simulator({
  chat: (u, t) => feed(room.chat(u, t)),
  gift: (u, c, n, g) => feed(room.gift(u, c, n, g)),
  like: (u, n) => feed(room.like(u, n)),
  share: (u) => feed(room.share(u)),
  follow: (u) => feed(room.follow(u)),
});

const t0 = Date.now();
let frame = 0;
while (results.length < rounds) {
  game.update(1000 / 60);
  if (live && ++frame % 45 === 0) sim.tick();
}
const ms = Date.now() - t0;

const secs = results.map((r) => r.secs).sort((a, b) => a - b);
const by = (reason: string) => results.filter((r) => r.reason === reason).length;
console.log(`рундове: ${rounds}, лимит ${GAME.roundSec}s, сметнато за ${ms}ms`);
console.log(`продължителност: мин ${secs[0].toFixed(0)}s, медиана ${secs[Math.floor(secs.length / 2)].toFixed(0)}s, макс ${secs[secs.length - 1].toFixed(0)}s`);
console.log(`край: последен оцелял ${by('last')}, по време ${by('time')}, няма ${by('none')}`);
console.log(`оцелели при край по време: ${results.filter((r) => r.reason === 'time').map((r) => r.alive).join(', ') || '-'}`);
