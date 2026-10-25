// Right-click shots from 12, 18 and 25 m: quick click (0.55), mid hold (0.8) and full (1.0), aimed just inside a post
// or at the middle, against a set keeper and one shuffling across. Everyone else is out of it.
import { GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W } from '/tmp/rt/controls/repo/src/sim/constants.ts';
import { goalkeeper } from '/tmp/rt/controls/repo/src/sim/field.ts';
import { fmt, giveBall, isolate, livePlay, step } from './lib.ts';

function shoot(d: number, ang: number, power: number, aimY: number, moving: boolean, seed: number) {
  const s = livePlay(seed);
  const me = s.players.find((p) => p.team === 0 && p.role === 'FWD')!;
  const gk = goalkeeper(s, 1);
  isolate(s, me, gk);
  gk.stun = 0;
  s.switchTimer[0] = 1e9;
  const a = (ang * Math.PI) / 180;
  const at = { x: PITCH_W - d * Math.cos(a), y: PITCH_H / 2 + d * Math.sin(a) };
  giveBall(s, me, at, { x: 1, y: 0 });
  // Let the keeper take up his position for ~1 s (he moves with the ball), then strike.
  gk.pos = { x: PITCH_W - 1, y: PITCH_H / 2 };
  for (let k = 0; k < 60; k++) step(s, { cursor: { ...at } });
  if (!moving) gk.vel = { x: 0, y: 0 };
  else gk.vel = { x: 0, y: (at.y > PITCH_H / 2 ? -1 : 1) * 2.5 }; // caught shuffling the wrong way
  giveBall(s, me, at, { x: 1, y: 0 });
  const target = { x: PITCH_W, y: aimY };
  const g0 = s.score[0];
  step(s, { cursor: target, aim: target, shoot: power });
  const v0 = Math.hypot(s.ball.vel.x, s.ball.vel.y);
  let maxZ = 0;
  let touched = false;
  for (let t = 0; t < 180 && s.phase === 'play'; t++) {
    step(s, { cursor: target });
    maxZ = Math.max(maxZ, s.ball.z);
    if (s.ball.lastTouch === gk.i) touched = true;
    if (s.ball.owner >= 0) break;
  }
  const goal = s.score[0] > g0;
  return { goal, saved: touched && !goal, miss: !touched && !goal, v0, maxZ };
}

const inside = 0.5;
for (const moving of [false, true]) {
  console.log(moving ? '\nKeeper shuffling the wrong way at 2.5 m/s' : 'Keeper set');
  for (const d of [12, 18, 25]) {
    for (const power of [0.55, 0.8, 1.0]) {
      const rs = [];
      for (const ang of [0, 20, -20])
        for (const aimY of [GOAL_TOP + inside, GOAL_BOTTOM - inside, PITCH_H / 2 + 1.5])
          for (const seed of [1, 2, 3]) rs.push(shoot(d, ang, power, aimY, moving, seed));
      const n = rs.length;
      console.log(`${d} m power ${power}: goals ${rs.filter((r) => r.goal).length}/${n}, saved ${rs.filter((r) => r.saved).length}, missed ${rs.filter((r) => r.miss).length}, kick ${fmt(rs.reduce((a, r) => a + r.v0, 0) / n, 1)} m/s, max height ${fmt(Math.max(...rs.map((r) => r.maxZ)), 2)} m`);
    }
  }
}
