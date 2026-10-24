// Do the tactics change how a side plays? Two copies of the same squad, same
// CPU skill and formation, one playing each mentality against one playing
// Balanced, alternating home and away. Deterministic: the same arguments give
// the same table.
//   bun run scripts/tactics-probe.ts [matches] [--formation 4-4-2] [--skill 0.6] [--quality 60]
//   bun run scripts/tactics-probe.ts [matches] --formations    each formation (Balanced) against a Balanced 4-4-2
//
// Columns are for the side being tested (A), per match:
//   GF GA      goals for and against            poss   share of the ball (%)
//   sh shA     shots for and against            pass   passes completed or not
//   fouls      fouls committed                  Y      yellow cards
//   line       out of possession, how far the deepest outfielder stands from his own goal line (m)
//   depth      out of possession, deepest to highest outfielder (m): smaller is more compact
//   width      out of possession, touchline-to-touchline spread of the outfielders (m)
//   press      out of possession, players within 6 m of the ball carrier
//   regain     where open-play regains happen, m from own goal (how high they win it back)
//   ahead      in possession, outfielders ahead of the ball (how many commit forward)
//   open       in possession, teammates within 14 m of the carrier with a clear passing lane
// What to expect: Park the bus sits deepest, narrowest and most compact,
// concedes fewer and scores fewer; High press holds the highest line, has the
// most players round the ball, wins it back highest up and fouls most.

import { autoLineup, generateSquad, toTeamSetup } from '../src/meta/club.ts';
import { averageMetrics, measureMatch, type TeamMetrics } from '../src/meta/tacticsProbe.ts';
import { FORMATION_IDS, HALF_SECONDS, isFormationId, MENTALITY_IDS, MENTALITY_LABEL, type FormationId, type Mentality } from '../src/sim/constants.ts';
import { makeRng } from '../src/sim/rng.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const VALUE_FLAGS = new Set(['--formation', '--skill', '--quality', '--half']);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
const n = Number(positional[0] ?? 20);
const skill = Number(flag('--skill', '0.6'));
const quality = Number(flag('--quality', '60'));
const baseFormation = flag('--formation', '4-4-2');
const halfSeconds = Number(flag('--half', String(HALF_SECONDS)));
if (!isFormationId(baseFormation)) throw new Error(`Unknown formation ${baseFormation}. One of ${FORMATION_IDS.join(', ')}`);
if (!Number.isFinite(n) || n < 1) throw new Error('Usage: bun run scripts/tactics-probe.ts [matches] [--formation 4-4-2] [--skill 0.6] [--quality 60] [--formations]');

const id = (name: string, primary: string) => ({ id: name, name, short: name.slice(0, 3).toUpperCase(), primary, secondary: '#fff', crest: 'plain' as const });

/** N matches of side A against side B (same squad), A's metrics averaged. */
function series(a: { formation: FormationId; mentality: Mentality }, b: { formation: FormationId; mentality: Mentality }): TeamMetrics {
  const list: TeamMetrics[] = [];
  for (let i = 0; i < n; i++) {
    const squad = generateSquad(makeRng(5000 + Math.floor(i / 2)), quality);
    const A = toTeamSetup(id('Side A', '#c00'), squad, autoLineup(squad, a.formation), skill, a.formation, a.mentality);
    const B = toTeamSetup(id('Side B', '#00c'), squad, autoLineup(squad, b.formation), skill, b.formation, b.mentality);
    const aHome = i % 2 === 0;
    const { teams } = measureMatch({ seed: 7100 + i, home: aHome ? A : B, away: aHome ? B : A, halfSeconds });
    list.push(teams[aHome ? 0 : 1]);
  }
  return averageMetrics(list);
}

const f1 = (v: number) => v.toFixed(1).padStart(5);
const f2 = (v: number) => v.toFixed(2).padStart(5);
const header = `${'side A'.padEnd(14)}   GF    GA  poss    sh   shA  pass fouls     Y  line depth width press regain ahead  open`;
const row = (label: string, m: TeamMetrics) =>
  `${label.padEnd(14)} ${f2(m.goalsFor)} ${f2(m.goalsAgainst)} ${f1(m.possession)} ${f1(m.shots)} ${f1(m.shotsAgainst)} ${f1(m.passes)} ${f1(m.fouls)} ${f2(m.yellows)} ${f1(m.line)} ${f1(m.depth)} ${f1(m.width)} ${f2(m.pressers)} ${f1(m.regainHeight).padStart(6)} ${f2(m.ahead)} ${f2(m.openShort)}`;

const t0 = performance.now();
if (args.includes('--formations')) {
  console.log(`Each formation (Balanced) vs a Balanced 4-4-2: ${n} matches each, skill ${skill}, squad quality ${quality}\n`);
  console.log(header.replace('side A        ', 'formation     '));
  for (const f of FORMATION_IDS) console.log(row(f, series({ formation: f, mentality: 'balanced' }, { formation: '4-4-2', mentality: 'balanced' })));
} else {
  console.log(`Each mentality vs Balanced, both ${baseFormation}: ${n} matches each, skill ${skill}, squad quality ${quality}\n`);
  console.log(header);
  for (const m of MENTALITY_IDS) console.log(row(MENTALITY_LABEL[m], series({ formation: baseFormation, mentality: m }, { formation: baseFormation, mentality: 'balanced' })));
}
console.log(`\n${((performance.now() - t0) / 1000).toFixed(1)} s`);
