import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
import { PITCH_W, GOAL_TOP, GOAL_BOTTOM, GOAL_BAR_H, BALL_R } from '/tmp/rt/rules/repo/src/sim/constants.ts';
const N = Number(process.argv[2] ?? 100);
let through = 0, goals = 0, overNear = 0, posts = 0;
const ex: string[] = [];
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 7000 + m, ...teams(m + 5), humans: [false, false] });
  while (s.phase !== 'fulltime') {
    const px = s.ball.pos.x, pz = s.ball.z, py = s.ball.pos.y;
    const g0 = s.goals.length;
    step(s);
    const b = s.ball;
    if (s.goals.length > g0) goals++;
    for (const line of [0, PITCH_W]) {
      const crossed = (px - line) * (b.pos.x - line) < 0;
      if (!crossed || s.phase === 'goal' && s.goals.length > g0) continue;
      const t = (line - px) / (b.pos.x - px);
      const y = py + (b.pos.y - py) * t, z = pz + (b.z - pz) * t;
      if (y > GOAL_TOP - BALL_R && y < GOAL_BOTTOM + BALL_R && z > GOAL_BAR_H - BALL_R && z < GOAL_BAR_H + 0.12 + BALL_R) { through++; if (ex.length < 8) ex.push(`m${m} t${s.tick} y=${y.toFixed(2)} z=${z.toFixed(2)}`); }
    }
  }
}
console.log(`${N} CPU matches: ${goals} goals; ${through} times the ball crossed the goal line at crossbar height (centre 2.33-2.67 m between the posts) and went straight through the bar`); console.log(ex);
