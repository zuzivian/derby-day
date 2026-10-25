import { newGame, clubTeam } from '/tmp/rt/firstsession/repo/src/meta/game.ts';
import { warmupTeam } from '/tmp/rt/firstsession/repo/src/meta/warmup.ts';
import { createMatch, step } from '/tmp/rt/firstsession/repo/src/sim/match.ts';
const N = Number(process.argv[2] ?? 20);
const res: Record<string, number> = { W: 0, D: 0, L: 0 };
let ticks = 0;
const rows: string[] = [];
for (let i = 1; i <= N; i++) {
  const save = newGame(i * 1013);
  const first = i % 2 === 0;
  const opp = warmupTeam(save, first);
  const s = createMatch({ seed: i * 17, home: clubTeam(save, 0.6), away: opp.away, humanTeam: 0 });
  // passive human: pointer on his own player, never clicks
  while (s.phase !== 'fulltime') { const p = s.players[s.controlled[0]]; step(s, { cursor: { x: p.pos.x, y: p.pos.y } }); }
  ticks += s.tick;
  const [a, b] = s.score; res[a > b ? 'W' : a === b ? 'D' : 'L']++;
  rows.push(`${first ? 'first' : 'warm'} ${a}-${b} ${(s.tick / 60 / 60).toFixed(2)}min`);
}
console.log(rows.join(' | '));
console.log('passive human results', res, 'avg real minutes per match', (ticks / N / 3600).toFixed(2));
