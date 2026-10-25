import { live, clearPitch, MID, step, PITCH_W, player } from './lib.ts';
import { GOAL_TOP, GOAL_BOTTOM, GOAL_BAR_H, BALL_R } from '/tmp/rt/rules/repo/src/sim/constants.ts';
let n = 0, through = 0, goal = 0, over = 0;
for (let i = 0; i < 300; i++) {
  const s = live(3 + (i % 5));
  clearPitch(s);
  const st = player(s, 0, 'ST');
  const d = 14 + (i % 17);
  st.pos = { x: PITCH_W - d, y: MID + ((i * 7) % 11) - 5 }; st.stun = 0; st.facing = { x: 1, y: 0 };
  s.ball.owner = st.i; s.ball.pos = { x: st.pos.x + 0.9, y: st.pos.y }; s.ball.z = 0;
  s.controlled[0] = st.i; s.ctlHold = [false, false];
  const aim = { x: PITCH_W + ((i * 13) % 25) / 10, y: GOAL_TOP + 0.5 + ((i * 17) % 63) / 10 };
  const power = 0.3 + ((i * 29) % 70) / 100;
  step(s, { cursor: aim, aim, loft: power, moved: true });
  n++;
  let zLine = -1, yLine = 0;
  for (let t = 0; t < 300 && s.phase === 'play'; t++) {
    const px = s.ball.pos.x, pz = s.ball.z, py = s.ball.pos.y;
    step(s, {});
    if (px <= PITCH_W && s.ball.pos.x > PITCH_W && zLine < 0) { const f = (PITCH_W - px) / (s.ball.pos.x - px); zLine = pz + (s.ball.z - pz) * f; yLine = py + (s.ball.pos.y - py) * f; }
  }
  if (zLine >= 0 && yLine > GOAL_TOP && yLine < GOAL_BOTTOM && zLine > GOAL_BAR_H - BALL_R && zLine < GOAL_BAR_H + 0.12 + BALL_R) through++;
  if (s.phase === 'goal') goal++;
}
console.log(`${n} human lobs at goal from 14-30 m (keeper and defenders frozen): ${goal} goals, ${through} (${(100 * through / n).toFixed(1)}%) passed through the crossbar`);
