// When the half-time / full-time whistle goes in CPU matches, where is the ball? Count shots in
// flight on target, and replay the same state with the clock extended to see if they would have scored.
import { PITCH_W, PITCH_H, GOAL_TOP, GOAL_BOTTOM, GOAL_BAR_H } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teamX } from '/tmp/rt/rules/repo/src/sim/field.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 60);
let whistles = 0, inFinalThird = 0, shotsInFlight = 0, wouldScore = 0; const ex: string[] = [];
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 4000 + m, ...teams(m + 31), humans: [false, false] });
  while (s.phase !== 'fulltime') {
    const near = s.clock >= s.halfTicks * s.half - 2;
    const clone = near ? structuredClone(s) : (null as any);
    const nEv = s.events.length;
    step(s);
    const w = s.events.slice(nEv).find((e) => e.kind === 'halftime' || e.kind === 'fulltime');
    if (!w || !clone) continue;
    whistles++;
    const b = clone.ball;
    const owner = b.owner >= 0 ? clone.players[b.owner] : null;
    const attTeam = owner ? owner.team : b.lastTouch >= 0 ? clone.players[b.lastTouch].team : null;
    if (attTeam !== null && teamX(attTeam, b.pos.x) > 2 / 3) inFinalThird++;
    const gx = b.vel.x > 0 ? PITCH_W : 0;
    const t = Math.abs(b.vel.x) > 1 ? (gx - b.pos.x) / b.vel.x : -1;
    if (!owner && t > 0 && t < 2 && Math.hypot(b.vel.x, b.vel.y) > 10) {
      const y = b.pos.y + b.vel.y * t;
      if (y > GOAL_TOP && y < GOAL_BOTTOM) {
        shotsInFlight++;
        // would it have gone in? run the clone on with the clock held back
        const c = clone; c.halfTicks += 600; const sc = c.score[0] + c.score[1];
        for (let k = 0; k < 150 && c.phase === 'play'; k++) step(c);
        if (c.score[0] + c.score[1] > sc) { wouldScore++; if (ex.length < 5) ex.push(`seed ${4000 + m} ${w.kind} at tick ${s.tick}: a shot ${Math.hypot(b.vel.x, b.vel.y).toFixed(1)} m/s, ${Math.abs(gx - b.pos.x).toFixed(1)} m out, on target, was in flight; given another second it is a goal`); }
      }
    }
  }
}
console.log({ matches: N, whistles, ballInAttackingThird: inFinalThird, onTargetShotsInFlight: shotsInFlight, thoseThatWouldHaveScored: wouldScore });
console.log(ex.join('\n'));
