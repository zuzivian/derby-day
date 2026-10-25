// Scan CPU-vs-CPU matches: goal-line crossings that passed through a post or the crossbar.
import { GOAL_TOP, GOAL_BOTTOM, PITCH_W, PITCH_H, GOAL_BAR_H, BALL_R } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 30);
let postThrough = 0, barThrough = 0, crossings = 0, mouth = 0, goals = 0, postHitsNear = 0;
const examples: string[] = [];
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 1000 + m, ...teams(m + 3), humans: [false, false] });
  while (s.phase !== 'fulltime') {
    const p0 = { ...s.ball.pos }; const z0 = s.ball.z; const ph = s.phase; const own = s.ball.owner;
    step(s);
    if (ph !== 'play' || own >= 0) continue;
    const p1 = s.ball.pos;
    for (const lx of [0, PITCH_W]) {
      const inside0 = lx === 0 ? p0.x >= 0 : p0.x <= PITCH_W;
      const beyond1 = lx === 0 ? p1.x < 0 : p1.x > PITCH_W;
      if (!(inside0 && beyond1)) continue;
      crossings++;
      const t = (lx - p0.x) / (p1.x - p0.x);
      const y = p0.y + (p1.y - p0.y) * t;
      const z = z0 + (s.ball.z - z0) * t;
      const dPost = Math.min(Math.abs(y - GOAL_TOP), Math.abs(y - GOAL_BOTTOM));
      if (y > GOAL_TOP && y < GOAL_BOTTOM) mouth++;
      if (dPost < BALL_R + 0.06 && z < GOAL_BAR_H + 0.2) { postThrough++; if (examples.length < 8) examples.push(`seed ${1000 + m} tick ${s.tick}: crossed line at y=${y.toFixed(3)} (post centre ${(y < 34 ? GOAL_TOP : GOAL_BOTTOM).toFixed(3)}), z=${z.toFixed(2)}, speed ${Math.hypot(s.ball.vel.x, s.ball.vel.y).toFixed(1)} -> ${s.phase === 'goal' ? 'GOAL' : s.restart?.kind}`); }
      if (y > GOAL_TOP && y < GOAL_BOTTOM && z > GOAL_BAR_H - BALL_R && z < GOAL_BAR_H + 0.12 + BALL_R) { barThrough++; if (examples.length < 16) examples.push(`seed ${1000 + m} tick ${s.tick}: BAR crossed at y=${y.toFixed(2)} z=${z.toFixed(2)} -> ${s.phase === 'goal' ? 'GOAL' : s.restart?.kind}`); }
    }
  }
  goals += s.score[0] + s.score[1];
}
console.log({ matches: N, goals, goalLineCrossings: crossings, inMouth: mouth, throughPost: postThrough, throughBar: barThrough });
console.log(examples.join('\n'));
