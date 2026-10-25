import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
let maxHold = 0, over6 = 0, holds = 0;
for (let m = 0; m < 60; m++) {
  const s = createMatch({ seed: 41000 + m, ...teams(m + 3), humans: [false, false] });
  let prev = 0;
  while (s.phase !== 'fulltime') {
    step(s);
    const h = s.ball.handTicks ?? 0;
    if (h === 0 && prev > 0) { holds++; maxHold = Math.max(maxHold, prev); if (prev > 360) over6++; }
    prev = h;
  }
}
console.log(`CPU keeper holds: ${holds}, longest ${(maxHold / 60).toFixed(1)} s, over 6 s: ${over6}`);
