// Headless CPU-vs-CPU matches at full speed. Because the sim is deterministic
// and DOM-free, balance questions ("is pace too strong?") become scripts.
//   bun run balance [matches] [--assert]
// Eleven-a-side, 2 x HALF_SECONDS (3 minutes) a half, each club in its own
// formation and mentality, drawn in turn from three ladders (seeds 2026-2028:
// one ladder's mix of deep and attacking clubs swings goals by a goal a match). With --assert the process exits non-zero when the averages leave
// the sane range, so CI catches a broken tuning change:
//   goals 1.5-5, passes >= 80, fouls 5-25, yellows 0.5-6, reds <= 1,
//   offsides 0.3-6, corners >= 1, and well under a second per match.
// The ranges are a little wider than the targets (about 2-4 goals, 8-20
// fouls, 1-4 yellows, 1-5 offsides, reds rare) so that 30 matches of
// sampling noise don't fail the build. Corners run below a real 90 minutes
// (about 2-3 a match): six real minutes of play rarely reach the byline as
// often as a full match does.

import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { expectedScore } from '../src/meta/elo.ts';
import { emptyTally, playCountingShots, shotTable } from '../src/meta/shotProbe.ts';
import { possessionShare } from '../src/sim/match.ts';
import type { TeamStats } from '../src/sim/types.ts';

const args = process.argv.slice(2);
const assertMode = args.includes('--assert');
const n = Number(args.find((a) => !a.startsWith('--')) ?? 30);
if (!Number.isFinite(n) || n < 1) throw new Error('Usage: bun run balance [matches] [--assert]');
const ladders = [2026, 2027, 2028].map((seed) => generateLadder(seed, 16));
let played = 0;
let goals = 0;
let favouriteWins = 0;
let draws = 0;
const sum: Record<keyof TeamStats, number> = {
  shots: 0, onTarget: 0, passes: 0, tackles: 0, possessionTicks: 0, fouls: 0, yellows: 0, reds: 0,
  corners: 0, offsides: 0, throwIns: 0, goalKicks: 0, freeKicks: 0, penalties: 0, passAttempts: 0,
};
const shotsByDistance = emptyTally();
const t0 = performance.now();
for (let i = 0; i < n; i++) {
  const clubs = ladders[i % ladders.length];
  const j = Math.floor(i / ladders.length);
  const a = clubs[j % clubs.length];
  const b = clubs[(j * 7 + 3) % clubs.length];
  if (a.id === b.id) continue;
  const s = playCountingShots({ seed: i, home: cpuTeam(a, ladderSquad(a)), away: cpuTeam(b, ladderSquad(b)) }, shotsByDistance);
  const [ga, gb] = s.score;
  played++;
  goals += ga + gb;
  for (const k of Object.keys(sum) as (keyof TeamStats)[]) sum[k] += s.stats[0][k] + s.stats[1][k];
  if (ga === gb) draws++;
  else if ((ga > gb) === expectedScore(a.elo, b.elo) > 0.5) favouriteWins++;
  if (i < 8) {
    const st = s.stats;
    console.log(`${a.name} (${a.elo}, ${s.teams[0].formation}) ${ga}–${gb} ${b.name} (${b.elo}, ${s.teams[1].formation})  poss ${possessionShare(s).join('/')}  shots ${st[0].shots}/${st[1].shots}  fouls ${st[0].fouls}/${st[1].fouls}  cards ${st[0].yellows + st[1].yellows}Y ${st[0].reds + st[1].reds}R`);
  }
}
const ms = performance.now() - t0;
const per = (k: keyof TeamStats) => sum[k] / Math.max(1, played);
const goalsPer = goals / Math.max(1, played);
const msPer = ms / Math.max(1, played);
console.log(`\n${played} matches in ${(ms / 1000).toFixed(1)}s (${msPer.toFixed(0)} ms each)`);
console.log(`goals/match ${goalsPer.toFixed(2)}  shots ${per('shots').toFixed(1)} (${per('onTarget').toFixed(1)} on target)  passes ${per('passes').toFixed(0)} of ${per('passAttempts').toFixed(0)}  tackles ${per('tackles').toFixed(1)}`);
console.log(`fouls ${per('fouls').toFixed(1)}  yellows ${per('yellows').toFixed(2)}  reds ${per('reds').toFixed(2)}  penalties ${per('penalties').toFixed(2)}`);
console.log(`corners ${per('corners').toFixed(1)}  offsides ${per('offsides').toFixed(1)}  throw-ins ${per('throwIns').toFixed(1)}  goal kicks ${per('goalKicks').toFixed(1)}  free kicks ${per('freeKicks').toFixed(1)}`);
console.log(`favourite won ${favouriteWins}, draws ${draws}, upsets ${played - favouriteWins - draws}`);
// Real football: about 4% of shots from 18-30 m score, and about 40% of shots come from there.
console.log(`shots by distance (share of shots, goal rate):\n${shotTable(shotsByDistance)}`);

if (assertMode) {
  const problems: string[] = [];
  const range = (label: string, v: number, lo: number, hi: number) => {
    if (!(v >= lo && v <= hi)) problems.push(`${label} ${v.toFixed(2)} is outside ${lo} to ${hi}`);
  };
  range('goals/match', goalsPer, 1.5, 5);
  range('passes/match', per('passes'), 80, Infinity);
  range('fouls/match', per('fouls'), 5, 25);
  range('yellows/match', per('yellows'), 0.5, 6);
  range('reds/match', per('reds'), 0, 1);
  range('offsides/match', per('offsides'), 0.3, 6);
  range('corners/match', per('corners'), 1, 15);
  range('ms/match', msPer, 0, 900);
  if (problems.length) {
    console.error(`\nBalance check FAILED:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  console.log('\nBalance check passed.');
}
