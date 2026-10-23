// Penalty shootouts you play yourself. Pure logic, no DOM, seeded randomness only.
//
// The goal mouth is a plane in normalised units, seen from the penalty spot:
//   x  -1 is the left post and +1 the right post (left/right as the taker sees
//      it, which is also how the front-on goal view is drawn); the keeper's
//      "left" dive is the same side.
//   y   0 is the ground and 1 the underside of the crossbar.
// An aim is where the taker means to put the ball. The ball ends up somewhere
// near it: how near depends on the taker's shooting and how hard he hits it.
//
// Power is 0..1 on a meter. Up to SWEET_HI the shot is accurate enough; past
// SKY_START it gets wild and may be skied; at MAX_POWER and over it always
// sails over the bar. Corners are riskier simply because the error pushes a
// corner shot wide or onto the frame more often than a shot into the middle.
//
// Format: best of five each, then sudden death. A side can win early once the
// other can no longer catch up. Every kick draws from its own rng derived from
// the seed and the kick number, so the same inputs always give the same kick.

import { gauss, hashString, makeRng, next, type Rng } from '../sim/rng.ts';
import { shortName, type Player } from './player.ts';

export const KICKS_PER_SIDE = 5;
/** Sudden-death rounds before a (very unlikely) coin toss settles it. */
export const SUDDEN_DEATH_CAP = 20;
/** At or above this power the ball always goes over the bar. */
export const MAX_POWER = 1;
/** From here up the chance of skying the ball grows. */
export const SKY_START = 0.8;
export const SWEET_LO = 0.45;
export const SWEET_HI = 0.8;
/** Half-width of the woodwork, in goal units. */
export const POST_W = 0.05;

/** -1 dives to the left, 0 stays central, 1 dives to the right. */
export type Dive = -1 | 0 | 1;
export type KickOutcome = 'goal' | 'saved' | 'post' | 'wide' | 'over';

export interface Aim {
  x: number;
  y: number;
}

export interface Taker {
  name: string;
  /** 0..1 */
  shooting: number;
}

export interface Keeper {
  name: string;
  /** 0..1 */
  goalkeeping: number;
}

export interface PenaltySide {
  name: string;
  /** Best shooter first. Cycles in sudden death. */
  takers: Taker[];
  keeper: Keeper;
}

export interface KickInput {
  aim: Aim;
  /** 0..1.5; anything over MAX_POWER is skied. */
  power: number;
  shooting: number;
  goalkeeping: number;
  dive: Dive;
}

export interface KickResult {
  outcome: KickOutcome;
  scored: boolean;
  /** Where the ball finished, in goal units (outside -1..1 or above 1 for a miss). */
  at: Aim;
  dive: Dive;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The five outfield players with the best shooting, best first, and the keeper. */
export function penaltySide(name: string, squad: Player[], lineup: string[]): PenaltySide {
  const xi = lineup.map((id) => squad.find((p) => p.id === id)).filter((p): p is Player => !!p);
  const gk = xi[0];
  const takers = xi
    .slice(1)
    .map((p) => ({ name: shortName(p), shooting: p.attrs.shooting / 100 }))
    .sort((x, y) => y.shooting - x.shooting);
  while (takers.length < KICKS_PER_SIDE) takers.push({ name: `Player ${takers.length + 2}`, shooting: 0.4 });
  return { name, takers, keeper: { name: gk ? shortName(gk) : 'Keeper', goalkeeping: (gk?.attrs.goalkeeping ?? 50) / 100 } };
}

/** Which third of the goal an x position is in, as a dive. */
export function diveFromX(x: number): Dive {
  return x < -0.33 ? -1 : x > 0.33 ? 1 : 0;
}

/** Chance (0..1) of skying a shot of this power. 1 at MAX_POWER and above. */
export function skyChance(power: number): number {
  if (power >= MAX_POWER) return 1;
  if (power <= SKY_START) return 0;
  const t = (power - SKY_START) / (MAX_POWER - SKY_START);
  return 0.5 * t * t;
}

/**
 * Resolve one kick. Always draws exactly four numbers from `r` so callers can
 * branch on the outcome without disturbing the stream.
 */
export function resolveKick(r: Rng, k: KickInput): KickResult {
  const ex = gauss(r);
  const ey = gauss(r);
  const skyRoll = next(r);
  const saveRoll = next(r);
  const power = clamp(k.power, 0, 1.5);
  const shooting = clamp(k.shooting, 0, 1);
  const g = clamp(k.goalkeeping, 0, 1);

  if (power >= MAX_POWER || skyRoll < skyChance(power)) {
    const at = { x: clamp(k.aim.x + ex * 0.12, -1.3, 1.3), y: 1.12 + 0.3 * Math.abs(ey) };
    return { outcome: 'over', scored: false, at, dive: k.dive };
  }

  const sigma = (0.3 - 0.2 * shooting) * (0.7 + 0.6 * power);
  // Soft shots are no more accurate than a sweet-spot one but easier to save (below).
  const at = { x: k.aim.x + ex * sigma, y: Math.max(0, k.aim.y + ey * sigma * 0.85) };
  const inX = Math.abs(at.x) <= 1 + POST_W;
  if (!inX) return { outcome: 'wide', scored: false, at, dive: k.dive };
  if (at.y > 1 + POST_W) return { outcome: 'over', scored: false, at, dive: k.dive };
  if (Math.abs(at.x) > 1 - POST_W || at.y > 1 - POST_W) return { outcome: 'post', scored: false, at, dive: k.dive };

  // On target. Did the keeper get there?
  let reach: number;
  let closeness: number;
  if (k.dive === 0) {
    reach = 0.3 + 0.15 * g;
    closeness = Math.abs(at.x) <= reach ? 1 - 0.4 * (at.x / reach) ** 2 : 0;
  } else {
    reach = 0.55 + 0.4 * g;
    const along = at.x * k.dive; // positive: ball is on the side he dived to
    closeness = along >= -0.05 && along <= reach ? 1 - 0.6 * (along / reach) ** 2 : 0;
  }
  const height = 1 - 0.45 * at.y * at.y;
  const hardness = 1.15 - 0.55 * power;
  const keeperSkill = 0.75 + 0.35 * g;
  const pSave = closeness === 0 ? 0 : clamp(closeness * height * hardness * keeperSkill * 0.95, 0, 0.97);
  if (saveRoll < pSave) return { outcome: 'saved', scored: false, at, dive: k.dive };
  return { outcome: 'goal', scored: true, at, dive: k.dive };
}

/** Where and how hard a CPU taker hits it: seeded, better shooters pick better corners. Draws 5. */
export function cpuTakerAim(r: Rng, shooting: number): { aim: Aim; power: number } {
  const s = clamp(shooting, 0, 1);
  const sideRoll = next(r);
  const mag = next(r);
  const high = next(r);
  const pw = next(r);
  const centreRoll = next(r);
  const side = sideRoll < 0.5 ? -1 : 1;
  const x = centreRoll < 0.08 ? (mag - 0.5) * 0.3 : side * (0.3 + (0.12 + 0.45 * s) * mag + 0.1 * s);
  const y = 0.12 + (0.35 + 0.4 * s) * high;
  return { aim: { x, y }, power: 0.5 + 0.25 * pw + 0.05 * s };
}

/**
 * The taker's tell during the run-up: which way he seems to be going. Weak
 * shooters give it away more often than good ones; otherwise it is a bluff.
 * Draws 2.
 */
export function penaltyTell(r: Rng, shooting: number, aim: Aim): Dive {
  const honest = next(r) < 0.25 + 0.4 * (1 - clamp(shooting, 0, 1));
  const bluff = next(r);
  if (honest) return diveFromX(aim.x);
  return bluff < 0.4 ? -1 : bluff < 0.8 ? 1 : 0;
}

/** A CPU keeper's dive: mostly a guess, sometimes a good read, more often with better goalkeeping. Draws 2. */
export function cpuKeeperDive(r: Rng, goalkeeping: number, aim: Aim): Dive {
  const read = next(r) < 0.08 + 0.3 * clamp(goalkeeping, 0, 1);
  const guess = next(r);
  if (read) return diveFromX(aim.x);
  return guess < 0.42 ? -1 : guess < 0.84 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The shootout itself

export interface KickRecord {
  side: 0 | 1;
  /** 0-based round: 0..4 regulation, then sudden death. */
  round: number;
  taker: string;
  outcome: KickOutcome;
  scored: boolean;
}

export interface Shootout {
  seed: number;
  sides: [PenaltySide, PenaltySide];
  /** Which side kicks first. */
  first: 0 | 1;
  kicks: KickRecord[];
  score: [number, number];
  /** Kicks taken by each side. */
  taken: [number, number];
  done: boolean;
  winner: 0 | 1 | null;
  /** True if sudden death hit SUDDEN_DEATH_CAP and a coin toss settled it. */
  coinToss: boolean;
}

export function createShootout(seed: number, a: PenaltySide, b: PenaltySide): Shootout {
  const first = next(makeRng(hashString(`${seed}:first`))) < 0.5 ? 0 : 1;
  return { seed, sides: [a, b], first, kicks: [], score: [0, 0], taken: [0, 0], done: false, winner: null, coinToss: false };
}

export interface Turn {
  side: 0 | 1;
  round: number;
  taker: Taker;
  keeper: Keeper;
  /** Index of this kick in the whole shootout. */
  kickNo: number;
}

/** Who kicks next, or null once it's decided. */
export function nextTurn(s: Shootout): Turn | null {
  if (s.done) return null;
  const other: 0 | 1 = s.first === 0 ? 1 : 0;
  const side = s.taken[s.first] <= s.taken[other] ? s.first : other;
  const foe: 0 | 1 = side === 0 ? 1 : 0;
  const round = s.taken[side];
  const takers = s.sides[side].takers;
  return { side, round, taker: takers[round % takers.length], keeper: s.sides[foe].keeper, kickNo: s.kicks.length };
}

/** Is it decided? Fills in done/winner. Early finish inside the first five; level-and-equal-kicks after. */
function settle(s: Shootout): void {
  const [ta, tb] = s.taken;
  const [sa, sb] = s.score;
  if (ta < KICKS_PER_SIDE || tb < KICKS_PER_SIDE) {
    const remA = Math.max(0, KICKS_PER_SIDE - ta);
    const remB = Math.max(0, KICKS_PER_SIDE - tb);
    if (sa > sb + remB) return finish(s, 0);
    if (sb > sa + remA) return finish(s, 1);
    return;
  }
  if (ta !== tb) return;
  if (sa !== sb) return finish(s, sa > sb ? 0 : 1);
  if (ta >= KICKS_PER_SIDE + SUDDEN_DEATH_CAP) {
    s.coinToss = true;
    finish(s, next(makeRng(hashString(`${s.seed}:coin`))) < 0.5 ? 0 : 1);
  }
}

function finish(s: Shootout, winner: 0 | 1): void {
  s.done = true;
  s.winner = winner;
}

/** Record a kick that already happened (the generic path; scripted tests use it directly). */
export function recordKick(s: Shootout, side: 0 | 1, taker: string, outcome: KickOutcome): KickRecord {
  if (s.done) throw new Error('The shootout is over');
  const scored = outcome === 'goal';
  const rec: KickRecord = { side, round: s.taken[side], taker, outcome, scored };
  s.kicks.push(rec);
  s.taken[side]++;
  if (scored) s.score[side]++;
  settle(s);
  return rec;
}

export interface KickPlan {
  turn: Turn;
  /** What a CPU taker would do. Used when the taker is a CPU. */
  cpuAim: Aim;
  cpuPower: number;
  /** The run-up tell for a CPU taker, to show a human keeper. */
  tell: Dive;
  /** What a CPU keeper would do against that aim. */
  cpuDive: Dive;
  /** Rng state the keeper's choice is drawn from (so it can read a human taker's real aim). */
  keeperSeed: number;
  /** Rng state for resolving the strike. */
  resolveSeed: number;
}

/**
 * Everything the CPU decides for the coming kick, from the seed alone. The UI
 * calls this before the human chooses (to show the tell), and playKick calls it
 * again, so both agree.
 */
export function planKick(s: Shootout): KickPlan | null {
  const turn = nextTurn(s);
  if (!turn) return null;
  const r = makeRng(hashString(`${s.seed}:kick:${turn.kickNo}`));
  const { aim, power } = cpuTakerAim(r, turn.taker.shooting);
  const tell = penaltyTell(r, turn.taker.shooting, aim);
  const keeperSeed = r.s;
  const cpuDive = cpuKeeperDive(r, turn.keeper.goalkeeping, aim);
  return { turn, cpuAim: aim, cpuPower: power, tell, cpuDive, keeperSeed, resolveSeed: r.s };
}

export interface KickChoice {
  /** Human taker's aim and power; leave out for a CPU taker. */
  aim?: Aim;
  power?: number;
  /** Human keeper's dive; leave out for a CPU keeper. */
  dive?: Dive;
}

export interface PlayedKick {
  turn: Turn;
  aim: Aim;
  power: number;
  tell: Dive;
  result: KickResult;
  record: KickRecord;
}

/** Play the next kick, using the human's choices where given and the CPU's seeded ones otherwise. */
export function playKick(s: Shootout, choice: KickChoice = {}): PlayedKick {
  const plan = planKick(s);
  if (!plan) throw new Error('The shootout is over');
  const aim = choice.aim ?? plan.cpuAim;
  const power = choice.power ?? plan.cpuPower;
  // A CPU keeper reads the aim the taker actually chose when the taker is human.
  const dive = choice.dive ?? cpuKeeperDive(makeRng(plan.keeperSeed), plan.turn.keeper.goalkeeping, aim);
  const result = resolveKick(makeRng(plan.resolveSeed), { aim, power, shooting: plan.turn.taker.shooting, goalkeeping: plan.turn.keeper.goalkeeping, dive });
  const record = recordKick(s, plan.turn.side, plan.turn.taker.name, result.outcome);
  return { turn: plan.turn, aim, power, tell: plan.tell, result, record };
}

/** Play the whole thing with both sides on CPU. */
export function runShootout(seed: number, a: PenaltySide, b: PenaltySide): Shootout {
  const s = createShootout(seed, a, b);
  for (let guard = 0; !s.done && guard < 200; guard++) playKick(s);
  return s;
}

/** The loser walks off: the other side wins. */
export function forfeitShootout(s: Shootout, loser: 0 | 1): void {
  if (s.done) return;
  finish(s, loser === 0 ? 1 : 0);
}

/** Score in the order (side 0, side 1). For a forfeit the winner is shown ahead by at least one. */
export function finalScore(s: Shootout): [number, number] {
  const [a, b] = s.score;
  if (s.winner === 0 && a <= b) return [b + 1, b];
  if (s.winner === 1 && b <= a) return [a, a + 1];
  return [a, b];
}

/** Kick marks for one side: true scored, false missed, null not yet taken. At least `min` long. */
export function marks(s: Shootout, side: 0 | 1, min = KICKS_PER_SIDE): (boolean | null)[] {
  const mine = s.kicks.filter((k) => k.side === side).map((k) => k.scored);
  const len = Math.max(min, mine.length);
  return Array.from({ length: len }, (_, i) => (i < mine.length ? mine[i] : null));
}

const OUTCOME_TEXT: Record<KickOutcome, string> = {
  goal: 'scores',
  saved: 'is saved',
  post: 'hits the woodwork',
  wide: 'misses wide',
  over: 'skies it over the bar',
};

/** "Smith scores" and the like, for announcements. */
export function describeKick(taker: string, keeper: string, outcome: KickOutcome): string {
  return outcome === 'saved' ? `${taker} is saved by ${keeper}` : `${taker} ${OUTCOME_TEXT[outcome]}`;
}
