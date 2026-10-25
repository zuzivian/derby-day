// In-match penalty: positions at the moment of the kick (Law 14), over many awarded penalties.
import { live, MID, step, PITCH_W, toReady } from './lib.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { inOwnBox, ownGoal, teamX } from '/tmp/rt/rules/repo/src/sim/field.ts';
import { GOAL_W, RETREAT, PENALTY_SPOT } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { dist } from '/tmp/rt/rules/repo/src/sim/vec.ts';
const bad: Record<string, number> = {}; const inc = (k: string) => (bad[k] = (bad[k] ?? 0) + 1);
let n = 0;
for (let i = 0; i < 40; i++) {
  const team = (i % 2) as 0 | 1;
  const s = live(20 + i, true);
  awardRestart(s, 'penalty', team, { x: team === 0 ? PITCH_W - 10 : 10, y: MID + (i % 7) - 3 }, 'foul');
  toReady(s);
  const r = s.restart!;
  let pre: any = null;
  for (let t = 0; t < 400 && s.phase === 'restart'; t++) { pre = { players: s.players.map((p) => ({ ...p.pos })) }; step(s); }
  if (s.phase !== 'play') { inc('not taken'); continue; }
  n++;
  const def = team === 0 ? 1 : 0;
  for (const p of s.players) {
    if (p.sentOff || p.i === r.taker) continue;
    const pp = pre.players[p.i];
    if (p.role === 'GK' && p.team === def) {
      if (Math.abs(pp.x - ownGoal(def).x) > 0.3 || Math.abs(pp.y - MID) > GOAL_W / 2) inc('keeper off his line');
      continue;
    }
    if (inOwnBox(def, pp)) inc('player in the area');
    if (dist(pp, r.spot) < RETREAT - 0.05) inc('player inside the arc (9.15 m)');
    if (teamX(team, pp.x) > teamX(team, r.spot.x) + 1e-6) inc('player ahead of the ball');
  }
}
console.log(`${n} penalties taken; violations at the kick:`, bad);
