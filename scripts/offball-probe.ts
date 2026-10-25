// Off-ball play: does each formation hold its shape, and how many passing
// options does the man on the ball have? Measures in src/meta/offballProbe.ts.
// Deterministic: the same arguments give the same tables.
//   bun run scripts/offball-probe.ts [matches] [--skill 0.6] [--quality 60] [--half 300] [--slots] [--human]
//
// Shape (each formation, Balanced, against a Balanced 4-4-2; CPU on both sides):
//   sX sY    best-fit stretch of the template along and across the pitch (1 = template size)
//   err      RMS distance of the average positions from the stretched template (m)
//   inst     the same moment to moment, averaged (m): how far players are out of their place
//   D M F    average height of the back, middle and front lines from own goal (m)
//   sprd     average front-to-back spread inside the back line (m): a flat line is small
//   mrg      % of samples where two lines are within 3 m (merged or crossed)
//   worst    the slot furthest from its place on average
// Options (while a carrier is on the ball, per sample):
//   open     teammates on for a pass (5-35 m, clear lane, nobody within 2.5 m of him)
//   2+ / 0   % of time with two or more open / with none
//   fwd      open teammates more than 5 m ahead of the ball
//   short    open teammates within 15 m
//   run      teammates on the last line or beyond it running forward (runs in behind)
//   wide     % of time in the opponents' half with a man near each touchline, ahead of the ball
//   <.5s..2s+  open teammates by how long the carrier has had the ball
//   m/s      the carrier's average speed
// --human: home is a scripted human (runs at goal, passes to the most forward open man);
// the table is then for his touches (he is switched to whoever has it), by formation and by mentality,
// with his side's goals and shots for and against (GF GA sh shA, per match).

import { autoLineup, generateSquad, toTeamSetup } from '../src/meta/club.ts';
import { addOpt, addShape, measureOffball, optionSummary, shapeSummary, type OffballResult, type OptionStats, type ShapePhase } from '../src/meta/offballProbe.ts';
import { FORMATION_IDS, formationOf, HALF_SECONDS, MENTALITY_IDS, MENTALITY_LABEL, type FormationId, type Mentality } from '../src/sim/constants.ts';
import { makeRng } from '../src/sim/rng.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const VALUE_FLAGS = new Set(['--skill', '--quality', '--half']);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
const n = Number(positional[0] ?? 10);
const skill = Number(flag('--skill', '0.6'));
const quality = Number(flag('--quality', '60'));
const halfSeconds = Number(flag('--half', String(HALF_SECONDS)));
const human = args.includes('--human');

const id = (name: string, primary: string) => ({ id: name, name, short: name.slice(0, 3).toUpperCase(), primary, secondary: '#fff', crest: 'plain' as const });

/** n matches of A against a Balanced 4-4-2. A is home in even matches (always home with a human). */
function series(f: FormationId, m: Mentality) {
  let acc: { shape: OffballResult['shape']; opt: OffballResult['options'][0]; hum: OffballResult['humanOptions'] } | null = null;
  const res = { gf: 0, ga: 0, sh: 0, sha: 0 };
  for (let i = 0; i < n; i++) {
    const squad = generateSquad(makeRng(5000 + Math.floor(i / 2)), quality);
    const A = toTeamSetup(id('Side A', '#c00'), squad, autoLineup(squad, f), skill, f, m);
    const B = toTeamSetup(id('Side B', '#00c'), squad, autoLineup(squad, '4-4-2'), skill, '4-4-2', 'balanced');
    const aHome = human || i % 2 === 0;
    const r = measureOffball({ seed: 7100 + i, home: aHome ? A : B, away: aHome ? B : A, halfSeconds }, human);
    const t = aHome ? 0 : 1;
    res.gf += r.state.score[t];
    res.ga += r.state.score[1 - t];
    res.sh += r.state.stats[t].shots;
    res.sha += r.state.stats[1 - t].shots;
    if (!acc) acc = { shape: [r.shape[t], r.shape[t]], opt: r.options[t], hum: r.humanOptions };
    else {
      addShape(acc.shape[0][0], r.shape[t][0]);
      addShape(acc.shape[0][1], r.shape[t][1]);
      addOpt(acc.opt, r.options[t]);
      addOpt(acc.hum, r.humanOptions);
    }
  }
  const slots = formationOf(f);
  return { inPoss: shapeSummary(acc!.shape[0][0], slots), outPoss: shapeSummary(acc!.shape[0][1], slots), options: optionSummary(acc!.opt), human: optionSummary(acc!.hum), res };
}

const f1 = (v: number) => v.toFixed(1).padStart(5);
const f2 = (v: number) => v.toFixed(2).padStart(5);
const shapeCols = (p: ShapePhase) => `${f2(p.stretchX)} ${f2(p.stretchY)} ${f1(p.meanErr)} ${f1(p.instErr)} ${p.lineX.map(f1).join('')} ${f1(p.lineSpread[0])} ${f1(p.merged)} ${p.worst.padStart(5)}`;
const shapeHead = '   sX    sY   err  inst    D    M    F  sprd   mrg worst';
const optCols = (o: OptionStats) => `${f2(o.open)} ${f1(o.twoPlus)} ${f1(o.none)} ${f2(o.forward)} ${f2(o.short)} ${f2(o.runners)} ${f1(o.width)} ${o.seconds.toFixed(0).padStart(6)} ${o.openByTime.map(f2).join('')} ${f1(o.speed)}`;
const optHead = ' open    2+     0   fwd short   run  wide  secs  <.5s   <1s   <2s   2s+   m/s';

const t0 = performance.now();
console.log(`${human ? 'Scripted human (home)' : 'CPU vs CPU'}, side A vs a Balanced 4-4-2: ${n} matches each, skill ${skill}, quality ${quality}, ${halfSeconds} s halves\n`);
if (!human) {
  console.log(`${'formation'.padEnd(9)} | IN POSSESSION${' '.repeat(shapeHead.length - 14)} | OUT OF POSSESSION${' '.repeat(shapeHead.length - 18)} | OPTIONS (any carrier)`);
  console.log(`${''.padEnd(9)} |${shapeHead} |${shapeHead} |${optHead}`);
  const all: [FormationId, ReturnType<typeof series>][] = FORMATION_IDS.map((f) => [f, series(f, 'balanced')]);
  for (const [f, r] of all) console.log(`${f.padEnd(9)} | ${shapeCols(r.inPoss)} | ${shapeCols(r.outPoss)} | ${optCols(r.options)}`);
  if (args.includes('--slots')) {
    for (const [f, r] of all) {
      console.log(`\n${f}: average position (x from own goal, y across) in / out of possession, error against the template (m)`);
      const tpl = formationOf(f).filter((s) => s.role !== 'GK');
      r.inPoss.slots.forEach((s, i) => {
        const o = r.outPoss.slots[i];
        console.log(`  ${s.label.padEnd(4)} tpl ${f1(tpl[i].x * 105)}${f1(tpl[i].y * 68)}   in ${f1(s.x)}${f1(s.y)} err ${f1(s.err)}   out ${f1(o.x)}${f1(o.y)} err ${f1(o.err)}`);
      });
    }
  }
} else {
  // GF GA sh shA: the human side's goals and shots for and against, per match.
  console.log(`${'side A'.padEnd(18)} |${optHead} |   GF    GA    sh   shA`);
  const tot = { gf: 0, ga: 0, sh: 0, sha: 0, n: 0 };
  const line = (label: string, r: ReturnType<typeof series>) => {
    for (const k of ['gf', 'ga', 'sh', 'sha'] as const) tot[k] += r.res[k];
    tot.n += n;
    console.log(`${label.padEnd(18)} | ${optCols(r.human)} | ${f2(r.res.gf / n)} ${f2(r.res.ga / n)} ${f1(r.res.sh / n)} ${f1(r.res.sha / n)}`);
  };
  for (const f of FORMATION_IDS) line(`${f} Balanced`, series(f, 'balanced'));
  for (const m of MENTALITY_IDS) if (m !== 'balanced') line(`4-4-2 ${MENTALITY_LABEL[m]}`, series('4-4-2', m));
  console.log(`${'all'.padEnd(18)} | ${' '.repeat(optHead.length - 1)} | ${f2(tot.gf / tot.n)} ${f2(tot.ga / tot.n)} ${f1(tot.sh / tot.n)} ${f1(tot.sha / tot.n)}   (${tot.n} matches)`);
}
console.log(`\n${((performance.now() - t0) / 1000).toFixed(1)} s`);
