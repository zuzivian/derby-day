import { loftPower } from '/tmp/rt/controls/repo/src/client/input.ts';
import { fmt, giveBall, isolate, livePlay, step, dist, len } from './lib.ts';
const s = livePlay(1);
const me = s.players[s.controlled[0]];
const mate = s.players.find((p) => p.team === 0 && p.role === 'MID' && p.i !== me.i)!;
isolate(s, me, mate);
s.switchTimer[0] = 1e9;
giveBall(s, me, { x: 8, y: 34 });
mate.pos = { x: 23, y: 34 }; mate.vel = { x: 0, y: 0 };
const aim = { ...mate.pos };
step(s, { cursor: aim, aim, loft: loftPower(364) });
for (let t = 0; t < 240; t++) {
  step(s, { cursor: aim });
  const b = s.ball;
  if (t % 6 === 0 || b.owner >= 0) console.log(`t=${fmt(t/60)} ball (${fmt(b.pos.x,1)},${fmt(b.pos.y,1)}) z=${fmt(b.z)} v=${fmt(len(b.vel),1)} vz=${fmt(b.vz,1)} owner=${b.owner} mate(${fmt(mate.pos.x,1)},${fmt(mate.pos.y,1)}) v=${fmt(len(mate.vel),1)} ctl=${s.controlled[0]===mate.i?'mate':s.controlled[0]} hold=${s.ctlHold?.[0]} gap=${fmt(dist(b.pos, mate.pos))}`);
  if (b.owner >= 0) break;
}
