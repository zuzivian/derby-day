// Fair matches for every kind of player. Scripted humans (src/meta/fairnessProbe.ts)
// play full matches through the real step(), from a player who never touches the
// mouse to a sharp one. Matches run in parallel worker processes (one per core);
// every match is seeded, so the tables are the same on any machine.
//
//   bun run fairness [careers] [--assert] [--matches=12] [--bots=cpu,passive,...]
//     Careers: each bot starts a new club and plays it the way the game does (first
//     match, warm-ups, then ranked against pickOpponent's choice with the CPU's skill
//     from the hidden estimate, src/meta/skill.ts), then a few friendlies against the
//     top of the ladder. The table compares the win chance shown before each match with
//     the results. --assert fails when the targets below are missed.
//   bun run fairness [seeds] --tiers=first,top
//     Fixed opponents at the club's own CPU skill, no estimate: the before-and-after
//     diagnosis of the human side (who presses, who is still, possession lost).
//   bun run fairness [seeds] --calibrate
//     Fits the result model in skill.ts (MODEL) to bots against CPU sides of every skill.

import { cpuTeam, ladderSquad, type LadderClub } from '../src/meta/club.ts';
import { BOT_IDS, playCareer, playFairness, type BotId, type CareerMatch, type FairnessResult } from '../src/meta/fairnessProbe.ts';
import { clubTeam, newGame, pickOpponent, type Save } from '../src/meta/game.ts';
import { HOME_SKILL, setupStrength } from '../src/meta/skill.ts';

const args = process.argv.slice(2);
const assertMode = args.includes('--assert');
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const shard = opt('shard');
const calibrate = args.includes('--calibrate');
const tierMode = !!opt('tiers');
const mode: 'career' | 'tiers' | 'calibrate' = calibrate ? 'calibrate' : tierMode ? 'tiers' : 'career';
const seeds = Number(args.find((a) => !a.startsWith('--')) ?? (mode === 'career' ? 8 : 20));
const careerLength = Number(opt('matches') ?? 12);
const TOP_MATCHES = 3;
const onlyBots = opt('bots')?.split(',');

type Tier = 'first' | 'top';
const TIERS: Tier[] = (opt('tiers')?.split(',') as Tier[] | undefined) ?? ['first', 'top'];
type Side = BotId | 'cpu';
const pickSides = (all: Side[]) => (onlyBots ? (onlyBots as Side[]) : all);
const CAREER_SIDES = pickSides(['cpu', 'passive', 'follow', 'chaser', 'competent', 'strong']);
const TIER_SIDES = pickSides(['cpu', ...BOT_IDS]);
const CAL_SKILLS = [-0.3, -0.15, 0, 0.15, 0.3, 0.45];
const CAL_SIDES = pickSides(['passive', 'chaser', 'competent', 'strong']);

interface Job {
  side: Side;
  i: number;
  tier?: Tier;
  /** The CPU's aiSkill, when the job sets it (calibration); else the club's own. */
  skill?: number;
}
const jobs: Job[] =
  mode === 'career'
    ? CAREER_SIDES.flatMap((side) => Array.from({ length: seeds }, (_, i) => ({ side, i })))
    : mode === 'calibrate'
      ? TIERS.flatMap((tier) => CAL_SIDES.flatMap((side) => CAL_SKILLS.flatMap((skill) => Array.from({ length: seeds }, (_, i) => ({ tier, side, i, skill })))))
      : TIERS.flatMap((tier) => TIER_SIDES.flatMap((side) => Array.from({ length: seeds }, (_, i) => ({ tier, side, i }))));

type MatchResult = FairnessResult & { aiSkill: number; gap: number; tier: Tier };
type CareerResult = { career: CareerMatch[]; top: CareerMatch[] };

function fixture(i: number, tier: Tier): { save: Save; opp: LadderClub } {
  const save = newGame(7000 + i);
  const opp = tier === 'first' ? pickOpponent(save) : [...save.ladder].sort((a, b) => b.elo - a.elo)[i % 3];
  return { save, opp };
}

function run(j: Job): MatchResult | CareerResult {
  const bot = j.side === 'cpu' ? null : j.side;
  if (mode === 'career') return playCareer(bot, 9000 + j.i, careerLength, TOP_MATCHES);
  const { save, opp } = fixture(j.i, j.tier!);
  const home = clubTeam(save, HOME_SKILL);
  const away = cpuTeam(opp, ladderSquad(opp), j.skill);
  const r = playFairness({ seed: 100 + j.i, home, away }, bot);
  return { ...r, aiSkill: away.aiSkill, gap: setupStrength(away) - setupStrength(home), tier: j.tier! };
}

if (shard) {
  // A worker: play every n-th job and print the results as JSON.
  const [k, n] = shard.split('/').map(Number);
  process.stdout.write(JSON.stringify(jobs.map((j, idx) => (idx % n === k ? run(j) : null))));
  process.exit(0);
}

const t0 = performance.now();
const workers = Math.max(1, Math.min(navigator.hardwareConcurrency || 2, 8, jobs.length));
const parts = await Promise.all(
  Array.from({ length: workers }, async (_, k) => {
    const p = Bun.spawn([process.execPath, import.meta.path, ...args.filter((a) => a !== '--assert'), `--shard=${k}/${workers}`], { stdout: 'pipe', stderr: 'inherit' });
    const text = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error(`fairness worker ${k} failed`);
    return JSON.parse(text) as unknown[];
  }),
);
const results = jobs.map((_, idx) => parts[idx % workers][idx]);
const secs = (performance.now() - t0) / 1000;

const pct = (x: number) => `${Math.round(100 * x)}%`;
const sgn = (x: number) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2);
const winOf = (ms: { gf: number; ga: number }[]) => ms.filter((m) => m.gf > m.ga).length / Math.max(1, ms.length);
const gdOf = (ms: { gf: number; ga: number }[]) => ms.reduce((t, m) => t + m.gf - m.ga, 0) / Math.max(1, ms.length);
const wdl = (ms: { gf: number; ga: number }[]) => `${ms.filter((m) => m.gf > m.ga).length}-${ms.filter((m) => m.gf === m.ga).length}-${ms.filter((m) => m.gf < m.ga).length}`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

if (mode === 'calibrate') fit(results as MatchResult[]);
else if (mode === 'tiers') tierTable(results as MatchResult[]);
else careerTable(results as CareerResult[]);

// ---------------------------------------------------------------------------
// Careers: the fairness targets

function careerTable(rs: CareerResult[]): void {
  console.log(`${seeds} careers of ${careerLength} matches per side, then ${TOP_MATCHES} against the ladder's top three; ${jobs.length * (careerLength + TOP_MATCHES)} matches on ${workers} workers in ${secs.toFixed(0)}s`);
  console.log('side        first 3 ranked     all ranked                                   settled      final     vs top 3 clubs');
  console.log('            W-D-L     GD       W-D-L     win  shown  GD       CPU skill   win  shown   estimate  W-D-L     win  shown  GD');
  const problems: string[] = [];
  const by = new Map<Side, CareerResult[]>();
  jobs.forEach((j, idx) => by.set(j.side, [...(by.get(j.side) ?? []), rs[idx]]));
  for (const [side, cs] of by) {
    const ranked = cs.flatMap((c) => c.career.filter((m) => m.ranked));
    const first = cs.flatMap((c) => c.career.filter((m) => m.ranked).slice(0, 3));
    const top = cs.flatMap((c) => c.top);
    const est = mean(cs.map((c) => c.career.at(-1)!.est));
    const shown = mean(ranked.map((m) => m.shown));
    // Settled: the ranked matches after the first three, once the estimate has had the warm-ups and a few
    // ranked results to learn from. The chance shown is held to the chance measured here.
    const settled = cs.flatMap((c) => c.career.filter((m) => m.ranked).slice(3));
    const settledShown = mean(settled.map((m) => m.shown));
    console.log(
      `${side.padEnd(10)}  ${wdl(first).padEnd(9)} ${sgn(gdOf(first)).padEnd(7)}  ${wdl(ranked).padEnd(9)} ${pct(winOf(ranked)).padStart(4)}  ${pct(shown).padStart(4)}   ${sgn(gdOf(ranked)).padEnd(7)}  ${mean(ranked.map((m) => m.aiSkill)).toFixed(2).padStart(6)}      ${pct(winOf(settled)).padStart(4)}  ${pct(settledShown).padStart(4)}    ${est.toFixed(2).padStart(5)}    ${wdl(top).padEnd(9)} ${pct(winOf(top)).padStart(4)}  ${pct(mean(top.map((m) => m.shown))).padStart(4)}   ${sgn(gdOf(top))}`,
    );
    if (!ranked.length) problems.push(`${side}: no ranked matches in ${careerLength}`);
    // Honest numbers: once settled, the chance shown is the chance measured (sampling noise allowed for).
    const tol = 2.2 * Math.sqrt(Math.max(0.05, settledShown * (1 - settledShown)) / Math.max(1, settled.length)) + 0.05;
    if (Math.abs(winOf(settled) - settledShown) > tol) problems.push(`${side}: won ${pct(winOf(settled))} of its settled ranked matches but was shown ${pct(settledShown)} (tolerance ±${pct(tol)})`);
    if (side === 'passive' && !(gdOf(first) > -3)) problems.push(`passive: goal difference ${gdOf(first).toFixed(2)} in the first ranked matches is a rout (target better than −3)`);
    if (side === 'competent' && !(winOf(ranked) >= 0.4 && winOf(ranked) <= 0.65)) problems.push(`competent: won ${pct(winOf(ranked))} of ranked matches (target about 45-60%)`);
    if (side === 'strong' && !(winOf(ranked) > 0.5)) problems.push(`strong: won ${pct(winOf(ranked))} of its ranked matches against a new club's opponents (target: most)`);
    if (side === 'strong' && !(winOf(top) < winOf(ranked) - 0.15)) problems.push(`strong: won ${pct(winOf(top))} against the top clubs, not clearly fewer than against a new club's opponents (${pct(winOf(ranked))})`);
  }
  if (assertMode) {
    if (problems.length) {
      console.error(`\nFairness check FAILED:\n - ${problems.join('\n - ')}`);
      process.exit(1);
    }
    console.log('\nFairness check passed.');
  }
}

// ---------------------------------------------------------------------------
// Fixed tiers: the diagnosis

function tierTable(rs: MatchResult[]): void {
  console.log(`${seeds} seeds per row, ${jobs.length} matches on ${workers} workers in ${secs.toFixed(0)}s`);
  console.log('tier   side        W-D-L      win   GD      shots      poss  unpressed  you-nearest  no-chaser  you-still  losses/touch');
  const rows = new Map<string, MatchResult[]>();
  jobs.forEach((j, idx) => rows.set(`${j.tier}:${j.side}`, [...(rows.get(`${j.tier}:${j.side}`) ?? []), rs[idx]]));
  for (const [key, ms] of rows) {
    const [tier, side] = key.split(':');
    const sum = (k: keyof FairnessResult) => ms.reduce((t, m) => t + (m[k] as number), 0);
    const share = (k: keyof FairnessResult) => pct(sum(k) / Math.max(1, sum('defending')));
    console.log(
      `${tier.padEnd(6)} ${side.padEnd(10)} ${wdl(ms).padEnd(9)} ${pct(winOf(ms)).padStart(4)}  ${sgn(gdOf(ms)).padEnd(6)}  ${(sum('shots') / ms.length).toFixed(1).padStart(4)}-${(sum('shotsAgainst') / ms.length).toFixed(1).padEnd(4)}  ${(sum('possession') / ms.length).toFixed(0).padStart(3)}%  ${share('unpressed').padStart(8)}  ${share('humanNearest').padStart(10)}  ${share('noChaser').padStart(9)}  ${share('humanStill').padStart(9)}  ${(sum('humanLosses') / Math.max(1, sum('humanTouches'))).toFixed(2)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Calibration

/**
 * Maximum-likelihood fit of the ordered logit in skill.ts: one level h per side, and the
 * shared spread, draw width and squad-strength weight. Grid search, plain and slow enough.
 */
function fit(rs: MatchResult[]): void {
  const L = (x: number) => 1 / (1 + Math.exp(-x));
  const bySide = new Map<Side, MatchResult[]>();
  jobs.forEach((j, idx) => bySide.set(j.side, [...(bySide.get(j.side) ?? []), rs[idx]]));
  const ll = (ms: MatchResult[], h: number, spread: number, drawW: number, sw: number) => {
    let t = 0;
    for (const r of ms) {
      const x = h - r.aiSkill - sw * r.gap;
      const win = L((x - drawW) / spread);
      const loss = L((-x - drawW) / spread);
      const p = r.gf > r.ga ? win : r.gf < r.ga ? loss : Math.max(1e-6, 1 - win - loss);
      t += Math.log(Math.max(1e-9, p));
    }
    return t;
  };
  let best = { total: -Infinity, spread: 0, drawW: 0, sw: 0, hs: new Map<Side, number>() };
  for (let spread = 0.04; spread <= 0.4; spread += 0.02)
    for (let drawW = 0; drawW <= 0.3; drawW += 0.02)
      for (let sw = 0; sw <= 0.05; sw += 0.005) {
        let total = 0;
        const hs = new Map<Side, number>();
        for (const [side, ms] of bySide) {
          let bh = 0;
          let bl = -Infinity;
          for (let h = -1; h <= 1.5; h += 0.02) {
            const v = ll(ms, h, spread, drawW, sw);
            if (v > bl) {
              bl = v;
              bh = h;
            }
          }
          hs.set(side, bh);
          total += bl;
        }
        if (total > best.total) best = { total, spread, drawW, sw, hs };
      }
  console.log(`${jobs.length} matches in ${secs.toFixed(0)}s`);
  console.log(`MODEL = { spread: ${best.spread.toFixed(2)}, drawW: ${best.drawW.toFixed(2)}, strengthW: ${best.sw.toFixed(3)} }  (log-likelihood ${best.total.toFixed(1)})`);
  for (const [side, h] of best.hs) console.log(`  ${side.padEnd(10)} level ${h.toFixed(2)}`);
  console.log('side       tier   skill  W-D-L     measured win  model win   gap');
  for (const [side, ms] of bySide)
    for (const tier of TIERS)
      for (const sk of CAL_SKILLS) {
        const g = ms.filter((r) => Math.abs(r.aiSkill - sk) < 1e-9 && r.tier === tier);
        const h = best.hs.get(side)!;
        const pw = mean(g.map((r) => L((h - r.aiSkill - best.sw * r.gap - best.drawW) / best.spread)));
        console.log(`${side.padEnd(10)} ${tier.padEnd(6)} ${sk.toFixed(2)}   ${wdl(g).padEnd(9)} ${pct(winOf(g)).padStart(6)}       ${pct(pw).padStart(6)}   ${mean(g.map((r) => r.gap)).toFixed(1)}`);
      }
}
