import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
const s = createMatch({ seed: 3, ...teams(7), halfSeconds: 20, humans: [false, false] });
const gk = (t: 0 | 1) => s.players.find((p) => p.team === t && p.role === 'GK')!;
console.log(`1st half kick-off team ${s.kickoffTeam}; home keeper at x=${gk(0).pos.x.toFixed(1)}, away keeper x=${gk(1).pos.x.toFixed(1)}`);
while (s.half === 1) step(s);
console.log(`2nd half kick-off team ${s.kickoffTeam}; home keeper at x=${gk(0).pos.x.toFixed(1)}, away keeper x=${gk(1).pos.x.toFixed(1)} (teams did ${gk(0).pos.x < 52 ? 'NOT ' : ''}change ends)`);
