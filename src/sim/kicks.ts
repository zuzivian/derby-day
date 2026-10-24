// Shared kick planning for human input, the renderer's previews and the CPU.
// Pure functions of state: no mutation, no rng.

import { resolvePassTarget } from './ai.ts';
import { AIR_DRAG, CHIP_Z0, GRAVITY } from './constants.ts';
import { clampToPitch } from './field.ts';
import type { MatchPlayer, MatchState } from './types.ts';
import { add, clamp, dist, len, norm, scale, sub, type Vec } from './vec.ts';

export interface ChipPlan {
  /** Where the ball first touches down. */
  landing: Vec;
  /** Initial horizontal speed. */
  speed: number;
  /** Initial vertical speed, from a start height of CHIP_Z0. */
  vz: number;
  /** Seconds in the air. */
  flight: number;
  /** Highest point of the flight, metres above the floor. */
  peak: number;
}

const peakOf = (vz: number): number => CHIP_Z0 + (vz * vz) / (2 * GRAVITY);

function lob(from: Vec, to: Vec, d: number, flight: number): ChipPlan {
  const speed = (d * AIR_DRAG) / (1 - Math.exp(-AIR_DRAG * flight));
  const dir = norm(len(to) < 1e-6 ? { x: 1, y: 0 } : to);
  const vz = (GRAVITY * flight) / 2 - CHIP_Z0 / flight;
  return { landing: add(from, scale(dir, d)), speed, vz, flight, peak: peakOf(vz) };
}

/** CPU chip. Power 0..1 sets how far it can travel; it lands on the target if that is within range. */
export function chipRange(power: number): number {
  return 6 + 30 * clamp(power, 0, 1);
}

export function chipPlan(from: Vec, target: Vec, power: number): ChipPlan {
  const to = sub(target, from);
  const d = clamp(Math.min(len(to), chipRange(power)), 3, 40);
  const flight = clamp(0.7 + 0.04 * d, 0.8, 1.8);
  return lob(from, to, d, flight);
}

/**
 * Human lofted ball. `hold` is 0..1, how long the button was held. The ball
 * lands on the target when it is within `loftRange(hold)`; further out it
 * comes down at the end of that range, in the same direction. A longer hold
 * reaches further and flies higher and slower (a looping cross rather than a
 * driven lob), so for one target the peak rises with the hold.
 */
export const LOFT_MIN_RANGE = 12;
export const LOFT_RANGE_GAIN = 28;

export function loftRange(hold: number): number {
  return LOFT_MIN_RANGE + LOFT_RANGE_GAIN * clamp(hold, 0, 1);
}

export function loftPlan(from: Vec, target: Vec, hold: number): ChipPlan {
  const h = clamp(hold, 0, 1);
  const to = sub(target, from);
  const d = clamp(Math.min(len(to), loftRange(h)), 3, 40);
  const flight = clamp(0.8 + 0.032 * d + 0.55 * h, 0.8, 2.4);
  return lob(from, to, d, flight);
}

// ---------------------------------------------------------------------------
// Ground pass to a point

/**
 * Rolling-ball constants, the same numbers updateBall in match.ts applies each
 * tick: speed falls at ROLL_FRICTION + ROLL_DRAG * speed m/s per second. A test
 * rolls a real ball and checks it ends where groundPassPlan said.
 */
const ROLL_FRICTION = 1.6;
const ROLL_DRAG = 0.35;
const ROLL_A = ROLL_FRICTION / ROLL_DRAG;
/** A ground pass reaches its point still rolling at this speed, so a runner can take it in stride. */
export const PASS_ARRIVAL_SPEED = 3;
const PASS_MAX_SPEED = 28;

/** Metres a ball kicked at v0 rolls before slowing to vEnd. */
function rollDistance(v0: number, vEnd: number): number {
  return (v0 - vEnd - ROLL_A * Math.log((v0 + ROLL_A) / (vEnd + ROLL_A))) / ROLL_DRAG;
}

export interface GroundPassPlan {
  /** Kick speed, m/s, that rolls the ball out to the target at PASS_ARRIVAL_SPEED. */
  speed: number;
  /** Seconds until it gets there. */
  flight: number;
}

/** What it takes to roll a ball `d` metres. Longer than the ball can go (about 60 m) caps at the hardest kick. */
export function groundPassPlan(d: number): GroundPassPlan {
  let lo = PASS_ARRIVAL_SPEED;
  let hi = PASS_MAX_SPEED;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (rollDistance(mid, PASS_ARRIVAL_SPEED) < d) lo = mid;
    else hi = mid;
  }
  const speed = clamp(hi, PASS_ARRIVAL_SPEED + 0.5, PASS_MAX_SPEED);
  return { speed, flight: Math.log((speed + ROLL_A) / (PASS_ARRIVAL_SPEED + ROLL_A)) / ROLL_DRAG };
}

/** A teammate within this many metres of the pointer (or of where they are running to) is the pass's receiver. */
export const PASS_ASSIST_R = 1.5;

/**
 * A human pass in pointer mode: the ball goes to the point under the pointer.
 * The one assist: if a teammate is standing, or running, within PASS_ASSIST_R of
 * the pointer, the ball is led to where they will be when it arrives and they
 * become the receiver. Nothing else is snapped: aim at empty grass and the ball
 * goes to that grass (receiver -1), which is how through balls are played.
 */
export function pointerPass(s: MatchState, p: MatchPlayer, aim: Vec): { target: Vec; receiver: number; speed: number } {
  const ball = s.ball.pos;
  let target = clampToPitch(aim, 0.5);
  let receiver = -1;
  let best = PASS_ASSIST_R;
  for (const m of s.players) {
    if (m.team !== p.team || m.i === p.i) continue;
    let lead = m.pos;
    if (len(m.vel) > 0.8) {
      // Where will they be when the ball gets there? Two passes of the fixed-point settle it.
      for (let k = 0; k < 2; k++) {
        const t = Math.min(groundPassPlan(dist(ball, lead)).flight, 1.5);
        lead = clampToPitch(add(m.pos, scale(m.vel, t)), 0.5);
      }
    }
    const near = Math.min(dist(aim, m.pos), dist(aim, lead));
    if (near < best) {
      best = near;
      receiver = m.i;
      target = lead;
    }
  }
  // A pointer on top of the ball: play it a couple of metres the way the player faces.
  if (dist(ball, target) < 2) {
    const way = norm(sub(target, ball));
    target = clampToPitch(add(ball, scale(way.x === 0 && way.y === 0 ? p.facing : way, 2)), 0.5);
  }
  return { target, receiver, speed: groundPassPlan(dist(ball, target)).speed };
}

/**
 * What a key-scheme pass toward `aim` does right now: the teammate closest to
 * the direction of travel gets it, to feet. (The pointer scheme uses pointerPass.)
 */
export function humanPass(s: MatchState, p: MatchPlayer, aim: Vec): { target: Vec; receiver: number } {
  return resolvePassTarget(s, p, aim);
}
