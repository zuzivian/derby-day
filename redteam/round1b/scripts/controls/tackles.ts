// Right-click tackles without the ball: a CPU carrier dribbling at us; the human's defender clicks with the
// pointer on the carrier from a range of distances and angles. Win, foul, whiff, and how long he is out of it.
import { fmt, isolate, livePlay, step, dist, len } from './lib.ts';

function tackle(gap: number, side: 'front' | 'side' | 'behind', pointerOn: 'carrier' | 'ball' | 'ahead', seed: number) {
  const s = livePlay(seed);
  const me = s.players.find((p) => p.team === 0 && p.role === 'DEF')!;
  const opp = s.players.find((p) => p.team === 1 && p.role === 'MID')!;
  isolate(s, me, opp);
  s.controlled[0] = me.i;
  s.switchTimer[0] = 1e9;
  // Carrier at (40,34) running toward our goal (-x) at 5 m/s with the ball.
  opp.pos = { x: 40, y: 34 };
  opp.vel = { x: -5, y: 0 };
  opp.facing = { x: -1, y: 0 };
  opp.stun = 0;
  const b = s.ball;
  b.owner = opp.i;
  b.pos = { x: 39, y: 34 };
  b.vel = { x: -5, y: 0 };
  b.z = 0;
  b.vz = 0;
  b.receiver = -1;
  b.lastTouch = opp.i;
  b.noPickup.fill(0);
  me.stun = 0;
  me.tackleCd = 0;
  me.pos = side === 'front' ? { x: 40 - gap, y: 34 } : side === 'side' ? { x: 40, y: 34 + gap } : { x: 40 + gap, y: 34 };
  me.vel = { x: 0, y: 0 };
  const aim = pointerOn === 'carrier' ? { ...opp.pos } : pointerOn === 'ball' ? { ...b.pos } : { x: opp.pos.x - 2, y: opp.pos.y };
  const fouls0 = s.stats[0].fouls;
  const tk0 = s.stats[0].tackles;
  step(s, { cursor: aim, aim, tackle: true, moved: true });
  const won = s.stats[0].tackles > tk0;
  const foul = s.stats[0].fouls > fouls0 || s.phase === 'restart';
  const stun = me.stun;
  const slide = dist(aim, me.pos) > 2.4;
  // Did we get the ball within 1 s?
  let ours = false;
  for (let t = 0; t < 60 && s.phase === 'play'; t++) {
    const v = len(b.vel);
    const chase = v > 0.3 ? { x: b.pos.x + (b.vel.x / v) * 6, y: b.pos.y + (b.vel.y / v) * 6 } : { ...b.pos };
    step(s, { cursor: process.env.CHASE ? chase : { ...b.pos }, moved: true });
    if (b.owner >= 0 && s.players[b.owner].team === 0) ours = true;
  }
  return { won, foul, stun, slide, ours, whiff: !won && !foul && stun > 0 };
}

for (const side of ['front', 'side', 'behind'] as const) {
  for (const pointerOn of ['carrier', 'ball'] as const) {
    const line = [];
    for (const gap of [1.0, 1.5, 1.9, 2.2, 2.6, 3.2, 4.0, 5.0]) {
      const rs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seed) => tackle(gap, side, pointerOn, seed));
      const c = (k: 'won' | 'foul' | 'whiff' | 'ours') => rs.filter((r) => r[k]).length;
      line.push(`${gap}m ${rs[0].slide ? 'slide' : 'stand'}: won ${c('won')} foul ${c('foul')} whiff ${c('whiff')} ours1s ${c('ours')} (stun ${rs[0].stun})`);
    }
    console.log(`${side}, pointer on ${pointerOn}:\n  ${line.join('\n  ')}`);
  }
}
