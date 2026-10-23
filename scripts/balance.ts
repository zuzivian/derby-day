// Headless CPU-vs-CPU matches at full speed. Because the sim is deterministic
// and DOM-free, balance questions ("is pace too strong?") become scripts.
//   bun run balance [matches] [--assert]
// With --assert the process exits non-zero when the averages leave the sane range
// (goals/match 1.5 to 6, passes/match at least 80), so CI catches a broken tuning change.

import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { expectedScore } from '../src/meta/elo.ts';
import { possessionShare, simulate } from '../src/sim/match.ts';

const args = process.argv.slice(2);
const assertMode = args.includes('--assert');
const n = Number(args.find((a) => !a.startsWith('--')) ?? 30);
if (!Number.isFinite(n) || n < 1) throw new Error('Usage: bun run balance [matches] [--assert]');
const clubs = generateLadder(2026, 16);
let played = 0;
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
  played++;
  goals += ga + gb;
  shots += s.stats[0].shots + s.stats[1].shots;
  passes += s.stats[0].passes + s.stats[1].passes;
  if (ga === gb) draws++;
  else if ((ga > gb) === expectedScore(a.elo, b.elo) > 0.5) favouriteWins++;
  if (i < 8) console.log(`${a.name} (${a.elo}) ${ga}–${gb} ${b.name} (${b.elo})  poss ${possessionShare(s).join('/')}  shots ${s.stats[0].shots}/${s.stats[1].shots}`);
}
const ms = performance.now() - t0;
console.log(`\n${played} matches in ${(ms / 1000).toFixed(1)}s (${(ms / Math.max(1, played)).toFixed(0)} ms each)`);
console.log(`goals/match ${(goals / Math.max(1, played)).toFixed(2)}  shots/match ${(shots / Math.max(1, played)).toFixed(1)}  passes/match ${(passes / Math.max(1, played)).toFixed(0)}`);
console.log(`favourite won ${favouriteWins}, draws ${draws}, upsets ${played - favouriteWins - draws}`);

if (assertMode) {
  const goalsPer = goals / Math.max(1, played);
  const passesPer = passes / Math.max(1, played);
  const problems: string[] = [];
  if (!(goalsPer >= 1.5 && goalsPer <= 6)) problems.push(`goals/match ${goalsPer.toFixed(2)} is outside 1.5 to 6`);
  if (!(passesPer >= 80)) problems.push(`passes/match ${passesPer.toFixed(0)} is below 80`);
  if (problems.length) {
    console.error(`\nBalance check FAILED:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  console.log('\nBalance check passed.');
}
