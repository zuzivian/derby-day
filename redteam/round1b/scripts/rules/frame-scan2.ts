// Scan CPU-vs-CPU matches for goal-line decisions at the posts:
//  tunnel = this tick's ball path passed within 0.17 m (ball r + post r) of a post centre, the
//           ball ended the tick clear of the post (no contact resolved), and crossed the line.
//  wrongSideGoal = crossed the line (centre) outside the post centre but was given as a goal.
import { GOAL_TOP, GOAL_BOTTOM, PITCH_W, GOAL_BAR_H, BALL_R } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 30);
const R = BALL_R + 0.06;
let tunnel = 0, tunnelGoal = 0, tunnelGK = 0, wrongSideGoal = 0, goals = 0, contacts = 0;
const ex: string[] = [];
const segD = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const abx = bx - ax, aby = by - ay; const l2 = abx * abx + aby * aby;
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / l2));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
};
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 1000 + m, ...teams(m + 3), humans: [false, false] });
  let pending: null | { kind: string; tick: number; y: number } = null;
  while (s.phase !== 'fulltime') {
    const p0 = { ...s.ball.pos }; const z0 = s.ball.z; const ph = s.phase; const own = s.ball.owner;
    const v0 = { ...s.ball.vel };
    step(s);
    if (ph !== 'play' || own >= 0) continue;
    const p1 = s.ball.pos;
    // where the ball would have gone without any contact
    const free = { x: p0.x + v0.x / 60, y: p0.y + v0.y / 60 };
    for (const lx of [0, PITCH_W]) for (const py of [GOAL_TOP, GOAL_BOTTOM]) {
      if (z0 > GOAL_BAR_H + 0.2) continue;
      const dSeg = segD(lx, py, p0.x, p0.y, free.x, free.y);
      const dEnd = Math.hypot(p1.x - lx, p1.y - py);
      if (Math.abs(dEnd - R) < 1e-6) contacts++;
      if (dSeg < R - 0.01 && dEnd > R + 1e-6 && Math.hypot(free.x - p1.x, free.y - p1.y) < 0.03) {
        tunnel++;
        const res = s.phase === 'goal' ? 'GOAL' : s.restart ? s.restart.kind : 'still in play';
        if (res === 'GOAL') tunnelGoal++; if (res === 'goalkick' || res === 'corner') tunnelGK++;
        if (ex.length < 10) ex.push(`seed ${1000 + m} tick ${s.tick}: ball path passed ${dSeg.toFixed(3)} m from the post centre (contact needs < ${R.toFixed(2)}), speed ${Math.hypot(v0.x, v0.y).toFixed(1)} m/s, z ${z0.toFixed(2)} -> ${res}`);
      }
    }
    // crossing side vs decision
    for (const lx of [0, PITCH_W]) {
      const in0 = lx === 0 ? p0.x >= -BALL_R : p0.x <= PITCH_W + BALL_R;
      const out1 = lx === 0 ? p1.x < -BALL_R : p1.x > PITCH_W + BALL_R;
      if (in0 && out1 && s.phase === 'goal') {
        const t = (lx - p0.x) / (p1.x - p0.x);
        const y = p0.y + (p1.y - p0.y) * Math.max(0, Math.min(1, t));
        if (y < GOAL_TOP || y > GOAL_BOTTOM) { wrongSideGoal++; if (ex.length < 14) ex.push(`seed ${1000 + m} tick ${s.tick}: GOAL although the ball crossed the goal line at y=${y.toFixed(3)}, outside the post (posts at ${GOAL_TOP.toFixed(2)} / ${GOAL_BOTTOM.toFixed(2)})`); }
      }
    }
  }
  goals += s.score[0] + s.score[1];
}
console.log({ matches: N, goals, postContactsResolved: contacts, tunnelledThroughPost: tunnel, tunnelThenGoal: tunnelGoal, tunnelThenGoalKickOrCorner: tunnelGK, goalAfterCrossingOutsidePost: wrongSideGoal });
console.log(ex.join('\n'));
