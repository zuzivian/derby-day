import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
import { goalkeeper, inOwnBox, ownGoal } from '/tmp/rt/rules/repo/src/sim/field.ts';
import { dist } from '/tmp/rt/rules/repo/src/sim/vec.ts';
const N = Number(process.argv[2] ?? 200);
let ogs = 0, ogsHeader = 0, goals = 0, defHeaders = 0, towardGoal = 0, passedKeeper = 0;
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 11000 + m, ...teams(m + 1), humans: [false, false] });
  let lastHeader: { team: 0 | 1; tick: number; near: boolean } | null = null;
  while (s.phase !== 'fulltime') {
    const kb0 = s.ball.kickedBy, z0 = s.ball.z, g0 = s.goals.length;
    step(s);
    const b = s.ball;
    if (b.kickedBy >= 0 && b.kickedBy !== kb0 && z0 > 1.5 && b.owner < 0) {
      const p = s.players[b.kickedBy];
      // header by a defender in his own box, heading toward his own goal line
      if (inOwnBox(p.team, p.pos)) {
        defHeaders++;
        const g = ownGoal(p.team);
        if ((g.x - b.pos.x) * b.vel.x > 0) { towardGoal++; lastHeader = { team: p.team, tick: s.tick, near: true }; }
        else lastHeader = null;
      } else lastHeader = null;
    } else if (b.kickedBy !== kb0 && b.kickedBy >= 0) lastHeader = null;
    if (lastHeader && b.kickedBy >= 0 && s.players[b.kickedBy].team === lastHeader.team) {
      const gk = goalkeeper(s, lastHeader.team);
      if (dist(gk.pos, b.pos) < 1.0 && b.z < 2.4) { passedKeeper++; lastHeader = { ...lastHeader, near: false }; }
    }
    if (s.goals.length > g0) {
      goals++;
      const g = s.goals.at(-1)!;
      if (g.ownGoal) { ogs++; if (lastHeader && b.kickedBy >= 0) ogsHeader++; }
      lastHeader = null;
    }
  }
}
console.log({ matches: N, goals, ownGoals: ogs, ownGoalsStraightFromOwnBoxHeaderTowardGoal: ogsHeader, defenderHeadersInOwnBox: defHeaders, ofThoseTowardOwnGoalLine: towardGoal, ballWithin1mOfOwnKeeperWhileHandsBarred: passedKeeper });
