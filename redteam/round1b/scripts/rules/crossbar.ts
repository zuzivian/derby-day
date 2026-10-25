// Is there a crossbar? A ball at bar height crossing the goal line between the posts.
import { live, clearPitch, MID, evs, step, PITCH_W, player } from './lib.ts';
import { GOAL_BAR_H, BALL_R } from '/tmp/rt/rules/repo/src/sim/constants.ts';
for (const z0 of [2.2, 2.3, 2.34, 2.4, 2.5, 2.6, 2.7]) {
  const s = live(3, true);
  clearPitch(s);
  const st = player(s, 0, 'ST');
  const b = s.ball;
  b.owner = -1; b.receiver = -1; b.pos = { x: PITCH_W - 1.0, y: MID + 1 }; b.vel = { x: 20, y: 0 }; b.z = z0; b.vz = 0;
  b.lastTouch = st.i; b.kickedBy = st.i; b.setPiece = null;
  const ev0 = s.events.length;
  let minX = 0, zAtLine = -1, maxX = 0;
  for (let t = 0; t < 200 && s.phase === 'play'; t++) {
    const px = b.pos.x;
    step(s);
    if (px <= PITCH_W && b.pos.x > PITCH_W && zAtLine < 0) zAtLine = b.z;
    maxX = Math.max(maxX, b.pos.x);
  }
  console.log(`ball centre ${z0.toFixed(2)} m (top ${(z0 + BALL_R).toFixed(2)}, bar underside ${GOAL_BAR_H}, bar top ${(GOAL_BAR_H + 0.12).toFixed(2)}): z at line ${zAtLine.toFixed(2)}, furthest x ${maxX.toFixed(2)} -> ${evs(s, ev0).filter((e) => !e.includes('Taken'))[0] ?? s.phase}`);
}
