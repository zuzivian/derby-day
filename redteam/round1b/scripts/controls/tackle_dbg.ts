import { isolate, livePlay, step, dist, len, fmt } from './lib.ts';
for (const seed of [1,2,3,4,5,6]) {
  const s = livePlay(seed);
  const me = s.players.find((p) => p.team === 0 && p.role === 'DEF')!;
  const opp = s.players.find((p) => p.team === 1 && p.role === 'MID')!;
  isolate(s, me, opp);
  s.controlled[0] = me.i; s.switchTimer[0] = 1e9;
  opp.pos = { x: 40, y: 34 }; opp.vel = { x: -5, y: 0 }; opp.facing = { x: -1, y: 0 }; opp.stun = 0;
  const b = s.ball; Object.assign(b, { owner: opp.i, pos: { x: 39, y: 34 }, vel: { x: -5, y: 0 }, z: 0, vz: 0, receiver: -1, lastTouch: opp.i }); b.noPickup.fill(0);
  me.stun = 0; me.tackleCd = 0; me.pos = { x: 40, y: 35 }; me.vel = { x: 0, y: 0 };
  const tk0 = s.stats[0].tackles;
  step(s, { cursor: { ...opp.pos }, aim: { ...opp.pos }, tackle: true, moved: true });
  if (s.stats[0].tackles === tk0) { console.log(seed, 'not won'); continue; }
  const log = [];
  for (let t = 0; t < 60 && s.phase === 'play'; t++) {
    step(s, { cursor: { ...b.pos }, moved: true });
    if (t % 6 === 0) log.push(`t${t}: ball(${fmt(b.pos.x,1)},${fmt(b.pos.y,1)}) v${fmt(len(b.vel),1)} own${b.owner} me(${fmt(me.pos.x,1)},${fmt(me.pos.y,1)}) st${me.stun} ctl${s.controlled[0]} hold${s.ctlHold?.[0]} opp(${fmt(opp.pos.x,1)},${fmt(opp.pos.y,1)}) st${opp.stun}`);
  }
  console.log(seed, s.phase, '\n ' + log.join('\n '));
  break;
}
