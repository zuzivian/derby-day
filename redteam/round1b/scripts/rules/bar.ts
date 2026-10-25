import { PITCH_W, PITCH_H, GOAL_BAR_H, GRAVITY } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { live, clearPitch, player } from './lib.ts';
// A ball arriving at the goal line (x=105, centre of goal) at height zLine, level flight (vz=0 at the line), 20 m/s.
for (const zLine of [2.2, 2.3, 2.36, 2.42, 2.48, 2.55, 2.62, 2.7]) {
  const s = live(); clearPitch(s);
  const st = player(s, 0, 'ST');
  const T = 0.5; // seconds to the line
  const b = s.ball;
  b.owner = -1; b.receiver = -1; b.pos = { x: PITCH_W - 20 * T, y: PITCH_H / 2 + 1 }; b.vel = { x: 20, y: 0 };
  b.z = zLine - 0.5 * GRAVITY * T * T; b.vz = GRAVITY * T; // apex at the line
  b.lastTouch = st.i; b.kickedBy = st.i; b.setPiece = null;
  let zAt = 0, bounced = false;
  for (let t = 0; t < 200 && s.phase === 'play'; t++) { const x0 = b.pos.x, z0 = b.z; step(s); if (x0 <= PITCH_W && b.pos.x > PITCH_W) zAt = z0; if (b.vel.x < 0) bounced = true; }
  console.log(`ball at the line ${zLine.toFixed(2)} m high (bar underside ${GOAL_BAR_H}, top ${GOAL_BAR_H + 0.12}): z at crossing ${zAt.toFixed(2)} -> ${s.phase === 'goal' ? 'GOAL' : s.restart?.kind}${bounced ? ' (came back off the bar)' : ''}`);
}
