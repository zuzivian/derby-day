import { newGame, clubTeam } from '/tmp/rt/firstsession/repo/src/meta/game.ts';
import { warmupTeam } from '/tmp/rt/firstsession/repo/src/meta/warmup.ts';
import { createMatch, step } from '/tmp/rt/firstsession/repo/src/sim/match.ts';
import { CoachTracker } from '/tmp/rt/firstsession/repo/src/client/coach.ts';
import { PITCH_W } from '/tmp/rt/firstsession/repo/src/sim/constants.ts';
// When does 'shoot' get offered (the tracker, before queueing delays), and how far from goal is the player then?
const ds: number[] = [];
for (let seed = 1; seed <= 30; seed++) {
  const save = newGame(seed * 7919);
  const s = createMatch({ seed: seed * 31, home: clubTeam(save, 0.6), away: warmupTeam(save, true).away, humanTeam: 0 });
  const tr = new CoachTracker(['run']); // run already seen: as in match 2+
  for (let t = 0; t < 60 * 360 && s.phase !== 'fulltime'; t++) {
    const p = s.players[s.controlled[0]];
    step(s, { cursor: { x: Math.min(PITCH_W - 2, p.pos.x + 9), y: p.pos.y }, moved: true });
    const got = tr.observe(s, 0);
    if (got.includes('shoot')) { const me = s.players[s.controlled[0]]; ds.push(Math.hypot(PITCH_W - me.pos.x, 34 - me.pos.y)); break; }
  }
}
ds.sort((a, b) => a - b);
console.log('distance to goal when the shoot tip is offered (m), n=', ds.length, 'min', ds[0].toFixed(1), 'median', ds[Math.floor(ds.length / 2)].toFixed(1), 'max', ds.at(-1)!.toFixed(1), 'share > 35 m', (ds.filter((d) => d > 35).length / ds.length).toFixed(2));
