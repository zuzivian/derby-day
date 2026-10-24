// Does CPU skill matter on its own? Plays N matches between two copies of the
// same squad that differ only in aiSkill, alternating home and away.
//   bun run scripts/ai-probe.ts [matches] [skillA] [skillB] [quality] [halfSeconds]

import { autoLineup, generateSquad, toTeamSetup } from '../src/meta/club.ts';
import { HALF_SECONDS } from '../src/sim/constants.ts';
import { simulate } from '../src/sim/match.ts';
import { makeRng } from '../src/sim/rng.ts';

const n = Number(process.argv[2] ?? 40);
const skillA = Number(process.argv[3] ?? 0.85);
const skillB = Number(process.argv[4] ?? 0.25);
const quality = Number(process.argv[5] ?? 60);
const halfSeconds = Number(process.argv[6] ?? HALF_SECONDS);

let w = 0;
let d = 0;
let l = 0;
let gfA = 0;
let gfB = 0;
let shotsA = 0;
let shotsB = 0;
let passesA = 0;
let passesB = 0;
const t0 = performance.now();
for (let i = 0; i < n; i++) {
  const squad = generateSquad(makeRng(5000 + Math.floor(i / 2)), quality);
  const lineup = autoLineup(squad);
  const id = (name: string, primary: string) => ({ id: name, name, short: name.slice(0, 3).toUpperCase(), primary, secondary: '#fff', crest: 'plain' as const });
  const a = toTeamSetup(id('Skill A', '#c00'), squad, lineup, skillA);
  const b = toTeamSetup(id('Skill B', '#00c'), squad, lineup, skillB);
  const aHome = i % 2 === 0;
  const s = simulate({ seed: 9000 + i, home: aHome ? a : b, away: aHome ? b : a, halfSeconds });
  const [ga, gb] = aHome ? s.score : [s.score[1], s.score[0]];
  const [sa, sb] = aHome ? [s.stats[0], s.stats[1]] : [s.stats[1], s.stats[0]];
  gfA += ga;
  gfB += gb;
  shotsA += sa.shots;
  shotsB += sb.shots;
  passesA += sa.passes;
  passesB += sb.passes;
  if (ga > gb) w++;
  else if (ga === gb) d++;
  else l++;
}
const ms = performance.now() - t0;
console.log(`skill ${skillA} vs ${skillB}, squad quality ${quality}, ${n} matches (${(ms / n).toFixed(0)} ms each)`);
console.log(`A: W${w} D${d} L${l}  (win ${((w / n) * 100).toFixed(0)}%, points share ${(((w * 3 + d) / (n * 3)) * 100).toFixed(0)}%)`);
console.log(`goals ${(gfA / n).toFixed(2)} – ${(gfB / n).toFixed(2)}  shots ${(shotsA / n).toFixed(1)} – ${(shotsB / n).toFixed(1)}  passes ${(passesA / n).toFixed(0)} – ${(passesB / n).toFixed(0)}`);
