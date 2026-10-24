// Training-ground drills for the first-run tutorial. Pure functions of
// MatchState, so they run headless in tests. The sim itself is untouched: a
// drill only places players, holds some of them still ("mannequins"), and
// filters which actions the human may use yet.

import { FORMATION, PITCH_H, PITCH_W } from '../sim/constants.ts';
import { createMatch } from '../sim/match.ts';
import type { HumanInput, MatchState, SimAttrs, TeamSetup } from '../sim/types.ts';
import { add, dist, scale, type Vec } from '../sim/vec.ts';

export type DrillId = 'move' | 'pass' | 'shoot' | 'tackle';
export const DRILLS: DrillId[] = ['move', 'pass', 'shoot', 'tackle'];

/** Player indices: ours are 0..5 in formation order, theirs 6..11. */
export const HUMAN = 5;
export const CARRIER = 11;
export const MARKER: Vec = { x: 38, y: 12 };
export const MARKER_R = 1.8;

/** Why a drill was set up again. The client turns these into coaching lines. */
export type Retry = 'walked-in' | 'no-receiver' | 'missed' | 'shoot-it' | 'conceded' | 'saved' | 'lost-it';
/** Feedback that doesn't reset the drill. */
export type Hint = 'too-far' | 'kept-it';

export interface Drill {
  id: DrillId;
  /** Players held still this drill, and where. */
  frozen: Map<number, Vec>;
  marker: Vec | null;
  base: { score: [number, number]; passes: number; tackles: number; shots: number };
  looseTicks: number;
  /** The human's tackle cooldown last tick; a jump means a tackle was tried. */
  lastTackleCd: number;
}

const SPARRING: SimAttrs = { pace: 0.05, shooting: 0.2, passing: 0.3, dribbling: 0.1, defending: 0.1, stamina: 0.5, goalkeeping: 0.2 };

function rgb(h: string): number[] {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const near = (a: string, b: string) => {
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 140;
};

/** A deliberately weak sparring side in training bibs that don't clash with our kit. */
export function sparringSide(home: TeamSetup): TeamSetup {
  const bibs: [string, string][] = [['#f97316', '#1c1c1c'], ['#f5f5f5', '#1c1c1c'], ['#1c1c1c', '#f5f5f5']];
  const [primary, secondary] = bibs.find(([p]) => !near(p, home.primary)) ?? bibs[0];
  return {
    name: 'Sparring bibs',
    short: 'SPR',
    primary,
    secondary,
    aiSkill: 0,
    players: FORMATION.map((f, i) => ({ id: `spar-${i}`, name: `Bib ${i + 1}`, number: i + 1, role: f.role, attrs: { ...SPARRING } })),
  };
}

export function createTraining(seed: number, home: TeamSetup): MatchState {
  // An hour-long half: the clock never matters on the training ground.
  return createMatch({ seed, home, away: sparringSide(home), halfSeconds: 3600, humanTeam: 0 });
}

const RIGHT: Vec = { x: 1, y: 0 };
const LEFT: Vec = { x: -1, y: 0 };

function place(s: MatchState, i: number, pos: Vec, facing: Vec): void {
  const p = s.players[i];
  p.pos = { ...pos };
  p.vel = { x: 0, y: 0 };
  p.facing = { ...facing };
  p.stun = 0;
  p.tackleCd = 0;
  p.kickCd = 0;
  p.holdTicks = 0;
  p.aiTimer = 24;
}

function giveBall(s: MatchState, i: number): void {
  const p = s.players[i];
  const b = s.ball;
  b.owner = i;
  b.lastTouch = i;
  b.receiver = -1;
  b.passFrom = -1;
  b.vel = { x: 0, y: 0 };
  b.pos = add(p.pos, scale(p.facing, 0.99));
  b.noPickup.fill(0);
}

type Layout = Record<number, Vec>;

/** Opponents standing still out of the way, keeper resting beside the post. */
const MANNEQUINS: Layout = { 6: { x: 62.3, y: 14.4 }, 7: { x: 52, y: 8 }, 8: { x: 52, y: 32 }, 9: { x: 43, y: 4.5 }, 10: { x: 43, y: 35.5 }, 11: { x: 30, y: 34 } };
const OUR_SHAPE: Layout = { 0: { x: 2.5, y: 20 }, 1: { x: 15, y: 12 }, 2: { x: 15, y: 28 }, 3: { x: 30, y: 7 }, 4: { x: 30, y: 33 } };
const OUR_ATTACK: Layout = { 0: { x: 2.5, y: 20 }, 1: { x: 24, y: 13 }, 2: { x: 24, y: 27 }, 3: { x: 40, y: 8 }, 4: { x: 40, y: 32 } };
/** For the tackle drill our outfielders watch from the boards so the human makes the tackle. */
const OUR_WATCHING: Layout = { 0: { x: 2.5, y: 20 }, 1: { x: 10, y: 4 }, 2: { x: 10, y: 36 }, 3: { x: 21, y: 2.5 }, 4: { x: 21, y: 37.5 } };
const THEIR_WATCHING: Layout = { 6: { x: 61, y: 20 }, 7: { x: 52, y: 6 }, 8: { x: 52, y: 34 }, 9: { x: 46, y: 3 }, 10: { x: 46, y: 37 } };

function baseline(s: MatchState): Drill['base'] {
  return { score: [s.score[0], s.score[1]], passes: s.stats[0].passes, tackles: s.stats[0].tackles, shots: s.stats[0].shots };
}

/**
 * Set up a drill. `fresh` places everyone again; without it the drill starts
 * from the current positions (used to flow from "move" straight into "pass").
 */
export function stageDrill(s: MatchState, id: DrillId, fresh = true): Drill {
  const frozen = new Map<number, Vec>();
  const freeze = (l: Layout) => {
    for (const [k, v] of Object.entries(l)) frozen.set(Number(k), { ...v });
  };
  if (id === 'tackle') {
    freeze(THEIR_WATCHING);
    for (const [k, v] of Object.entries(OUR_WATCHING)) if (k !== '0') frozen.set(Number(k), { ...v });
  } else freeze(MANNEQUINS);

  if (fresh) {
    const ours = id === 'shoot' ? OUR_ATTACK : id === 'tackle' ? OUR_WATCHING : OUR_SHAPE;
    for (const [k, v] of Object.entries(ours)) place(s, Number(k), v, RIGHT);
    for (const [k, v] of frozen) if (k >= 6) place(s, k, v, LEFT);
    if (id === 'tackle') {
      place(s, CARRIER, { x: 46, y: 20 }, LEFT);
      place(s, HUMAN, { x: 33, y: 16 }, RIGHT);
      giveBall(s, CARRIER);
    } else {
      place(s, CARRIER, MANNEQUINS[CARRIER], LEFT);
      const start = id === 'shoot' ? { x: 47, y: 20 } : id === 'pass' ? MARKER : { x: 24, y: 22 };
      place(s, HUMAN, start, RIGHT);
      giveBall(s, HUMAN);
    }
    s.phase = 'play';
    s.phaseTicks = 0;
    s.controlled[0] = HUMAN;
    s.switchTimer[0] = 30;
  }
  const d: Drill = { id, frozen, marker: id === 'move' ? { ...MARKER } : null, base: baseline(s), looseTicks: 0, lastTackleCd: s.players[HUMAN].tackleCd };
  holdFrozen(s, d);
  return d;
}

/** Call before and after every step: frozen players stay put and can't touch the ball. */
export function holdFrozen(s: MatchState, d: Drill): void {
  for (const [i, pos] of d.frozen) {
    const p = s.players[i];
    p.stun = Math.max(p.stun, 2);
    p.pos = { ...pos };
    p.vel = { x: 0, y: 0 };
  }
  // In the tackle drill the human stays on the striker even if a watcher is nearer the ball.
  if (d.id === 'tackle' && s.ball.owner !== HUMAN) s.controlled[0] = HUMAN;
}

/** Only the actions the current drill teaches (and the ones before it) reach the sim. */
export function filterInput(id: DrillId, input: HumanInput): HumanInput {
  const out: HumanInput = {};
  if (input.cursor) out.cursor = input.cursor;
  if (input.dir) out.dir = input.dir;
  if (input.pass && id === 'pass') out.pass = true;
  if (input.loft !== undefined && id === 'pass') out.loft = input.loft;
  if (input.shoot !== undefined && id === 'shoot') out.shoot = input.shoot;
  if (input.tackle && id === 'tackle') out.tackle = true;
  return out;
}

export type DrillStatus = { done: true } | { done: false; retry: Retry | null; hint?: Hint };

/** Call after every step. Says whether the drill is passed, or needs setting up again and why. */
export function checkDrill(s: MatchState, d: Drill): DrillStatus {
  const b = s.ball;
  const loose = b.owner < 0;
  d.looseTicks = loose ? d.looseTicks + 1 : 0;
  const ourGoal = s.score[0] > d.base.score[0];
  const theirGoal = s.score[1] > d.base.score[1];

  switch (d.id) {
    case 'move':
      if (d.marker && dist(s.players[HUMAN].pos, d.marker) < MARKER_R) return { done: true };
      return { done: false, retry: ourGoal ? 'walked-in' : null };
    case 'pass':
      // A ground pass is counted by the sim when the receiver takes it; a lofted one is not, so
      // also count a teammate (not the keeper) ending up with the ball the human started with.
      if (s.stats[0].passes > d.base.passes) return { done: true };
      if (b.owner >= 0 && b.owner !== HUMAN && s.players[b.owner].team === 0 && s.players[b.owner].role !== 'GK') return { done: true };
      if (ourGoal) return { done: false, retry: 'walked-in' };
      // A pass into empty space that nobody runs onto.
      return { done: false, retry: d.looseTicks > 150 ? 'no-receiver' : null };
    case 'shoot':
      if (ourGoal) return s.stats[0].shots > d.base.shots ? { done: true } : { done: false, retry: 'shoot-it' };
      if (b.owner >= 0 && b.owner !== HUMAN) return { done: false, retry: 'missed' };
      return { done: false, retry: d.looseTicks > 180 ? 'missed' : null };
    case 'tackle': {
      const h = s.players[HUMAN];
      const tried = h.tackleCd > d.lastTackleCd;
      // A slide leaves a much longer cooldown than a standing tackle, so a jump that big was a slide.
      const slid = h.tackleCd - d.lastTackleCd > 50;
      d.lastTackleCd = h.tackleCd;
      if (s.stats[0].tackles > d.base.tackles || b.owner === HUMAN) return { done: true };
      if (theirGoal) return { done: false, retry: 'conceded' };
      if (b.owner === 0) return { done: false, retry: 'saved' };
      if (d.looseTicks > 180) return { done: false, retry: 'lost-it' };
      if (tried) return { done: false, retry: null, hint: dist(h.pos, s.players[CARRIER].pos) > (slid ? 3.1 : 1.9) ? 'too-far' : 'kept-it' };
      return { done: false, retry: null };
    }
  }
}

/** True for points inside the pitch, used to sanity-check layouts in tests. */
export const onPitch = (p: Vec): boolean => p.x > 0 && p.x < PITCH_W && p.y > 0 && p.y < PITCH_H;
