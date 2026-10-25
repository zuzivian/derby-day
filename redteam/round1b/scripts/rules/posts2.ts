import { GOAL_TOP, PITCH_W } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { live, clearPitch, player } from './lib.ts';
// Ball centre passes the post centre (0.06 m radius post + 0.11 m ball => contact if |dy| < 0.17 m).
for (const speed of [12, 18, 24, 30]) {
  const row: string[] = [];
  for (const dy of [-0.14, -0.07, 0, 0.07, 0.14]) {
    let touched = 0, goal = 0, gk = 0;
    const N = 60;
    for (let k = 0; k < N; k++) {
      const s = live(); clearPitch(s);
      const st = player(s, 0, 'ST');
      const b = s.ball;
      b.owner = -1; b.receiver = -1; b.pos = { x: PITCH_W - 6 - (k / N) * (speed / 60), y: GOAL_TOP + dy }; b.vel = { x: speed, y: 0 }; b.z = 0.3; b.vz = 0;
      b.lastTouch = st.i; b.kickedBy = st.i; b.setPiece = null;
      let hit = false;
      for (let t = 0; t < 200 && s.phase === 'play'; t++) { const vx = b.vel.x, vy = b.vel.y; step(s); if (Math.abs(b.vel.y - vy * (1)) > 0.05 || b.vel.x < 0) hit = true; }
      if (hit) touched++;
      if (s.phase === 'goal') goal++; else if (s.restart?.kind === 'goalkick') gk++;
    }
    row.push(`dy=${dy.toFixed(2)}: post contact ${Math.round((100 * touched) / N)}%, goal ${goal}, goal kick ${gk}`);
  }
  console.log(`${speed} m/s | ` + row.join(' | '));
}
