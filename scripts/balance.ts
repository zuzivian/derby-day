// Headless CPU-vs-CPU matches at full speed. Because the sim is deterministic
// and DOM-free, balance questions ("is pace too strong?") become scripts.
//   bun run balance [matches]

import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { expectedScore } from '../src/meta/elo.ts';
import { possessionShare, simulate } from '../src/sim/match.ts';

const n = Number(process.argv[2] ?? 30);
const clubs = generateLadder(2026, 16);
let goals = 0;
let favouriteWins = 0;
let draws = 0;
let shots = 0;
let passes = 0;
const t0 = performance.now();
for (let i = 0; i < n; i++) {
  const a = clubs[i % clubs.length];
  const b = clubs[(i * 7 + 3) % clubs.length];
  if (a.id === b.id) continue;
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  const s = simulate({ seed: i, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) });
  const [ga, gb] = s.score;
  goals += ga + gb;
  shots += s.stats[0].shots + s.stats[1].shots;
  passes += s.stats[0].passes + s.stats[1].passes;
  if (ga === gb) draws++;
  else if ((ga > gb) === expectedScore(a.elo, b.elo) > 0.5) favouriteWins++;
  if (i < 8) console.log(`${a.name} (${a.elo}) ${ga}–${gb} ${b.name} (${b.elo})  poss ${possessionShare(s).join('/')}  shots ${s.stats[0].shots}/${s.stats[1].shots}`);
}
const ms = performance.now() - t0;
console.log(`\n${n} matches in ${(ms / 1000).toFixed(1)}s (${(ms / n).toFixed(0)} ms each)`);
console.log(`goals/match ${(goals / n).toFixed(2)}  shots/match ${(shots / n).toFixed(1)}  passes/match ${(passes / n).toFixed(0)}`);
console.log(`favourite won ${favouriteWins}, draws ${draws}, upsets ${n - favouriteWins - draws}`);
