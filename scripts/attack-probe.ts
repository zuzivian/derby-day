// How sides attack the final third: box entries, through balls, runs in
// behind, cut-backs, crosses, shots by zone and xG, per mentality and in total.
// The fixtures are balance.ts's (the three ladders, each club in its own
// formation and mentality), so the totals match its shots-by-distance table.
//   bun run scripts/attack-probe.ts [matches]
//   bun run scripts/attack-probe.ts [matches] --human    a scripted human (home) who passes to the most advanced open runner
// Deterministic: the same arguments give the same table. Columns (per team-match):
//   GF/m xG/m sh/m      goals, xG (src/meta/attackProbe.ts shotXg) and shots
//   box% boxCv          share of shots from inside the box, and the share of those scored
//   18-30% 18-30Cv      the same for shots from 18-30 m
//   entries/m           box entries, split by carry, pass, cross and other (loose balls)
//   edge>box%           possessions that reached 18-28 m from goal and went on into the box
//   thru/m cmp%         through balls played beyond the second-last defender, and completed
//   runs/m              attackers crossing that line at speed while their side has the ball
//   cut/m cmp% cross/m cmp%   cut-backs from the byline and crosses, and how many found a teammate
//   pass%               pass completion

import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { addAttack, ATTACK_HEADER, attackRow, emptyAttack, measureAttack, scriptedRunnerHuman, zoneTable, type AttackTally } from '../src/meta/attackProbe.ts';
import { MENTALITY_IDS, MENTALITY_LABEL, type Mentality } from '../src/sim/constants.ts';

const args = process.argv.slice(2);
const human = args.includes('--human');
const n = Number(args.find((a) => !a.startsWith('--')) ?? 60);
if (!Number.isFinite(n) || n < 1) throw new Error('Usage: bun run scripts/attack-probe.ts [matches] [--human]');

const ladders = [2026, 2027, 2028].map((seed) => generateLadder(seed, 16));
const by = Object.fromEntries(MENTALITY_IDS.map((m) => [m, emptyAttack()])) as Record<Mentality, AttackTally>;
const total = emptyAttack();
const humanSide = emptyAttack();
const t0 = performance.now();
let played = 0;
for (let i = 0; i < n; i++) {
  const clubs = ladders[i % ladders.length];
  const j = Math.floor(i / ladders.length);
  const a = clubs[j % clubs.length];
  const b = clubs[(j * 7 + 3) % clubs.length];
  if (a.id === b.id) continue;
  const home = cpuTeam(a, ladderSquad(a));
  const away = cpuTeam(b, ladderSquad(b));
  played++;
  if (human) {
    const { teams } = measureAttack({ seed: i, home, away, humanTeam: 0 }, scriptedRunnerHuman(0));
    addAttack(humanSide, teams[0]);
    addAttack(total, teams[1]);
    addAttack(by[away.mentality ?? 'balanced'], teams[1]);
    continue;
  }
  const { teams } = measureAttack({ seed: i, home, away });
  for (const side of [0, 1] as const) {
    addAttack(total, teams[side]);
    addAttack(by[(side ? away : home).mentality ?? 'balanced'], teams[side]);
  }
}
console.log(`${played} matches${human ? ' (home side: scripted human)' : ''} in ${((performance.now() - t0) / 1000).toFixed(1)} s\n`);
console.log(ATTACK_HEADER);
if (human) console.log(attackRow('scripted human', humanSide));
for (const m of MENTALITY_IDS) if (by[m].matches) console.log(attackRow(`${MENTALITY_LABEL[m]} (${by[m].matches})`, by[m]));
console.log(attackRow(human ? 'CPU sides' : 'all', total));
console.log(`\nshots by zone (${human ? 'scripted human' : 'all'}):\n${zoneTable(human ? humanSide : total)}`);
