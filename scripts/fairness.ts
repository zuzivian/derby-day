// Fair matches for every kind of player: scripted humans (src/meta/fairnessProbe.ts)
// play full matches through the real step() against CPU clubs, next to the
// CPU-vs-CPU baseline with the same squads. Matches run in parallel worker
// processes (one per core); every match is seeded, so the table is the same
// on any machine.
//   bun run fairness [seeds] [--assert] [--bots=cpu,passive,...] [--tiers=first,top]

import { cpuTeam, ladderSquad, type LadderClub } from '../src/meta/club.ts';
import { clubTeam, newGame, pickOpponent, type Save } from '../src/meta/game.ts';
import { BOT_IDS, playFairness, type BotId, type FairnessResult } from '../src/meta/fairnessProbe.ts';

const args = process.argv.slice(2);
const assertMode = args.includes('--assert');
const seeds = Number(args.find((a) => !a.startsWith('--')) ?? 20);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const onlyBots = opt('bots')?.split(',');
const shard = opt('shard');

type Tier = 'first' | 'top';
const TIERS: Tier[] = (opt('tiers')?.split(',') as Tier[] | undefined) ?? ['first', 'top'];
type Side = BotId | 'cpu';
const SIDES: Side[] = (['cpu', ...BOT_IDS] as Side[]).filter((b) => !onlyBots || onlyBots.includes(b)).concat(onlyBots?.includes('strongcpu') ? ['strongcpu'] : []);

function fixture(i: number, tier: Tier): { save: Save; opp: LadderClub } {
  const save = newGame(7000 + i);
  const opp = tier === 'first' ? pickOpponent(save) : [...save.ladder].sort((a, b) => b.elo - a.elo)[i % 3];
  return { save, opp };
}

interface Job {
  tier: Tier;
  side: Side;
  i: number;
}
const jobs: Job[] = TIERS.flatMap((tier) => SIDES.flatMap((side) => Array.from({ length: seeds }, (_, i) => ({ tier, side, i }))));

function run(j: Job): FairnessResult {
  const { save, opp } = fixture(j.i, j.tier);
  return playFairness({ seed: 100 + j.i, home: clubTeam(save, 0.6), away: cpuTeam(opp, ladderSquad(opp)) }, j.side === 'cpu' ? null : j.side);
}

if (shard) {
  // A worker: play every n-th job and print the results as JSON.
  const [k, n] = shard.split('/').map(Number);
  const out = jobs.map((j, idx) => (idx % n === k ? run(j) : null));
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const t0 = performance.now();
const workers = Math.max(1, Math.min(navigator.hardwareConcurrency || 2, 8));
const parts = await Promise.all(
  Array.from({ length: workers }, async (_, k) => {
    const p = Bun.spawn([process.execPath, import.meta.path, ...args.filter((a) => !a.startsWith('--assert')), `--shard=${k}/${workers}`], { stdout: 'pipe', stderr: 'inherit' });
    const text = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error(`fairness worker ${k} failed`);
    return JSON.parse(text) as (FairnessResult | null)[];
  }),
);
const results = jobs.map((_, idx) => parts[idx % workers][idx]!);
const ms = performance.now() - t0;

interface Row {
  n: number;
  w: number;
  d: number;
  l: number;
  gf: number;
  ga: number;
  shots: number;
  shotsA: number;
  poss: number;
  unpressed: number;
  defending: number;
  humanNearest: number;
  losses: number;
  touches: number;
  noChaser: number;
  still: number;
}
const rows = new Map<string, Row>();
jobs.forEach((j, idx) => {
  const key = `${j.tier}:${j.side}`;
  const r = rows.get(key) ?? { n: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, shots: 0, shotsA: 0, poss: 0, unpressed: 0, defending: 0, humanNearest: 0, losses: 0, touches: 0, noChaser: 0, still: 0 };
  const x = results[idx];
  r.n++;
  if (x.gf > x.ga) r.w++;
  else if (x.gf === x.ga) r.d++;
  else r.l++;
  r.gf += x.gf;
  r.ga += x.ga;
  r.shots += x.shots;
  r.shotsA += x.shotsAgainst;
  r.poss += x.possession;
  r.unpressed += x.unpressed;
  r.defending += x.defending;
  r.humanNearest += x.humanNearest;
  r.losses += x.humanLosses;
  r.touches += x.humanTouches;
  r.noChaser += x.noChaser;
  r.still += x.humanStill;
  rows.set(key, r);
});

const f = (x: number, n: number, d = 2) => (x / Math.max(1, n)).toFixed(d);
const pct = (x: number, n: number) => `${Math.round((100 * x) / Math.max(1, n))}%`;
const sgn = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
console.log(`${seeds} seeds per row, ${jobs.length} matches on ${workers} workers in ${(ms / 1000).toFixed(1)}s`);
console.log('tier   side        W-D-L      win   GF    GA    GD     shots      poss  unpressed  you-nearest  no-chaser  you-still  losses/touch');
for (const [key, r] of rows) {
  const [tier, side] = key.split(':');
  console.log(
    `${tier.padEnd(6)} ${side.padEnd(10)} ${`${r.w}-${r.d}-${r.l}`.padEnd(9)} ${pct(r.w, r.n).padStart(4)}  ${f(r.gf, r.n)}  ${f(r.ga, r.n)}  ${sgn((r.gf - r.ga) / r.n)}  ${f(r.shots, r.n, 1).padStart(4)}-${f(r.shotsA, r.n, 1).padEnd(4)}  ${f(r.poss, r.n, 0).padStart(3)}%  ${pct(r.unpressed, r.defending).padStart(8)}  ${pct(r.humanNearest, r.defending).padStart(10)}  ${pct(r.noChaser, r.defending).padStart(9)}  ${pct(r.still, r.defending).padStart(9)}  ${f(r.losses, r.touches)}`,
  );
}
if (assertMode) {
  // filled in once the targets are met
}
