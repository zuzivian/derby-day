// Penalty shootouts you play yourself. Pure logic, no DOM, seeded randomness only. The kick itself (the goal
// mouth's units, aim, power and the keeper's dive) is sim/penalty.ts, shared with a penalty in a match.
//
// Format: best of five each, then sudden death. A side can win early once the
// other can no longer catch up. Every kick draws from its own rng derived from
// the seed and the kick number, so the same inputs always give the same kick.

import { hashString, makeRng, next } from '../sim/rng.ts';
import { cpuKeeperDive, cpuTakerAim, penaltyTell, resolveKick, type Aim, type Dive, type KickOutcome, type KickResult } from '../sim/penalty.ts';
import type { MatchState } from '../sim/types.ts';
import { shortName, type Player } from './player.ts';

// The kick itself (resolveKick and the CPU's choices) is the sim's, so a penalty in a match is the same kick.
export * from '../sim/penalty.ts';

export const KICKS_PER_SIDE = 5;
/** Sudden-death rounds before a (very unlikely) coin toss settles it. */
export const SUDDEN_DEATH_CAP = 20;

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

/**
 * The order of kicks for a lineup: the outfield players best shooter first, then the keeper
 * (Law 10: nobody kicks twice until every eligible player has kicked once).
 */
export function penaltySide(name: string, squad: Player[], lineup: string[]): PenaltySide {
  const xi = lineup.map((id) => squad.find((p) => p.id === id)).filter((p): p is Player => !!p);
  const gk = xi[0];
  const takers = xi
    .slice(1)
    .map((p) => ({ name: shortName(p), shooting: p.attrs.shooting / 100 }))
    .sort((x, y) => y.shooting - x.shooting);
  while (takers.length < KICKS_PER_SIDE) takers.push({ name: `Player ${takers.length + 2}`, shooting: 0.4 });
  if (gk) takers.push({ name: shortName(gk), shooting: gk.attrs.shooting / 100 });
  return { name, takers, keeper: { name: gk ? shortName(gk) : 'Keeper', goalkeeping: (gk?.attrs.goalkeeping ?? 50) / 100 } };
}

/**
 * Law 10, after a drawn match: only the players on the pitch at full time take kicks (not
 * anyone sent off), the keeper is whoever was in goal at the end, and the side with more
 * players leaves out its weakest shooters so both have the same number. Outfield players
 * kick best shooter first, the keeper last.
 */
export function matchPenaltySides(m: MatchState): [PenaltySide, PenaltySide] {
  const on = ([0, 1] as const).map((team) => m.players.filter((p) => p.team === team && !p.sentOff));
  const n = Math.min(on[0].length, on[1].length);
  return ([0, 1] as const).map((team) => {
    const gk = on[team].find((p) => p.role === 'GK') ?? on[team][0];
    const outfield = on[team].filter((p) => p !== gk).sort((x, y) => y.attrs.shooting - x.attrs.shooting).slice(0, Math.max(0, n - 1));
    const takers: Taker[] = outfield.map((p) => ({ name: p.name, shooting: p.attrs.shooting }));
    if (gk) takers.push({ name: gk.name, shooting: gk.attrs.shooting });
    return { name: m.teams[team].name, takers, keeper: { name: gk?.name ?? 'Keeper', goalkeeping: gk?.attrs.goalkeeping ?? 0.5 } };
  }) as [PenaltySide, PenaltySide];
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
