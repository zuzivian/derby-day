// Scene: shots straight along x at the right-hand goal (x=105), at a lateral offset dy from the post centre (GOAL_TOP).
import { GOAL_TOP, PITCH_W, PITCH_H, BALL_R } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { live, clearPitch, roll, player } from './lib.ts';
const MID = PITCH_H / 2;
for (const speed of [15, 22, 28]) {
  for (const dy of [-0.15, -0.08, 0, 0.08, 0.15]) {
    const out = { goal: 0, goalkick: 0, post: 0, other: 0 } as Record<string, number>;
    for (let k = 0; k < 40; k++) {
      const s = live(); clearPitch(s);
      const st = player(s, 0, 'ST');
      const y = GOAL_TOP + dy;
      // vary the phase of the ball's tick positions relative to the line
      const x0 = PITCH_W - 8 - (k / 40) * (speed / 60);
      let bounced = false;
      const b = s.ball;
      b.owner = -1; b.receiver = -1; b.pos = { x: x0, y }; b.vel = { x: speed, y: 0 }; b.z = 0.3; b.vz = 0;
      b.lastTouch = st.i; b.kickedBy = st.i; b.setPiece = null;
      for (let t = 0; t < 200 && s.phase === 'play'; t++) { step(s); if (s.ball.vel.x < 0) bounced = true; }
      if (s.phase === 'goal') out.goal++; else if (s.restart?.kind === 'goalkick') out[bounced ? 'post' : 'goalkick']++; else if (bounced) out.post++; else out.other++;
    }
    console.log(`speed ${speed} m/s, ball centre ${dy >= 0 ? '+' : ''}${dy.toFixed(2)} m from post centre (+ = inside): ${JSON.stringify(out)}`);
  }
}
