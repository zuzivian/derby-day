// A penalty kick, taker against keeper: where it goes and whether it is saved. The same model decides a penalty
// in a match (match.ts penaltyStrike) and a kick in a shootout (meta/shootout.ts). Pure, seeded randomness only.
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

import { gauss, next, type Rng } from './rng.ts';

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
