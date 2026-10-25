// After a centre-back is sent off, does the back line close the gap?
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams, MID } from './lib.ts';
import { issueCard } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { teamX } from '/tmp/rt/rules/repo/src/sim/field.ts';
function run(sendOff: boolean) {
  let gapSum = 0, n = 0, centreSum = 0;
  for (let m = 0; m < 20; m++) {
    const s = createMatch({ seed: 400 + m, ...teams(m + 1), humans: [false, false] });
    for (let t = 0; t < 60; t++) step(s);
    if (sendOff) issueCard(s, s.players.find((p) => p.team === 1 && p.sub === 'CB')!, 'red', 'excessive');
    while (s.phase !== 'fulltime') {
      step(s);
      if (s.phase !== 'play' || teamX(1, s.ball.pos.x) > 0.4 || s.ball.owner < 0 || s.players[s.ball.owner].team !== 0) continue;
      // team 1 defending its own third: the back line's y positions
      const ys = s.players.filter((p) => p.team === 1 && !p.sentOff && p.role === 'DEF').map((p) => p.pos.y).sort((a, b) => a - b);
      let gap = 0; for (let i = 1; i < ys.length; i++) gap = Math.max(gap, ys[i] - ys[i - 1]);
      gapSum += gap; n++;
      // nearest outfielder of team 1 to the penalty spot area in front of goal
      const spot = { x: PITCH_W_ - 12, y: MID };
      centreSum += Math.min(...s.players.filter((p) => p.team === 1 && !p.sentOff && p.role !== 'GK').map((p) => Math.hypot(p.pos.x - spot.x, p.pos.y - spot.y)));
    }
  }
  return `widest gap in the back line ${(gapSum / n).toFixed(1)} m; nearest outfielder to the penalty spot ${(centreSum / n).toFixed(1)} m (${n} ticks)`;
}
const PITCH_W_ = 105;
console.log('11 men:            ', run(false));
console.log('CB sent off (10):  ', run(true));
