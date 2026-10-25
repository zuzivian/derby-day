// When the half/full-time whistle goes: how often was a goal about to be scored in the next 1.5 s?
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 150);
let halves = 0, cut = 0, inAttack = 0; const ex: string[] = [];
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 13000 + m, ...teams(m + 9), humans: [false, false] });
  while (s.phase !== 'fulltime') {
    if ((s.phase === 'play') && s.clock === s.halfTicks * s.half - 1) {
      halves++;
      const c = structuredClone(s);
      c.halfTicks = 1e9;
      const g0 = c.goals.length;
      for (let t = 0; t < 90 && c.phase === 'play'; t++) step(c);
      if (c.goals.length > g0) { cut++; if (ex.length < 6) ex.push(`m${m} half ${s.half}: ball ${s.ball.pos.x.toFixed(1)},${s.ball.pos.y.toFixed(1)} v ${Math.hypot(s.ball.vel.x, s.ball.vel.y).toFixed(1)} owner ${s.ball.owner}`); }
    }
    step(s);
  }
}
console.log(`${halves} halves ended in open play; in ${cut} (${(100 * cut / halves).toFixed(1)}%) a goal followed within 1.5 s if play had gone on`); console.log(ex);
