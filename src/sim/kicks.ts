// Shared kick planning for human input, the renderer's previews and the CPU.
// Pure functions of state: no mutation, no rng.

import { resolvePassTarget } from './ai.ts';
import { AIR_DRAG, CHIP_Z0, GRAVITY, ROLL_A, ROLL_B, ROLL_FAST_B, ROLL_FAST_V } from './constants.ts';
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
  return 6 + 44 * clamp(power, 0, 1);
}

export function chipPlan(from: Vec, target: Vec, power: number): ChipPlan {
  const to = sub(target, from);
  const d = clamp(Math.min(len(to), chipRange(power)), 3, 50);
  const flight = clamp(0.7 + 0.04 * d, 0.8, 2.6);
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
 * The rolling ball, integrated exactly: the same deceleration updateBall in
 * match.ts applies each tick (rollDecel in constants.ts: ROLL_A + ROLL_B * v
 * below ROLL_FAST_V, a gentler speed term above). A test rolls a real ball and
 * checks it ends where groundPassPlan said.
 */
/**
 * A ground pass into space reaches its point still rolling at this speed, so a runner
 * can take it in stride; it then stops a few metres on.
 */
export const PASS_ARRIVAL_SPEED = 3.5;
const PASS_MAX_SPEED = 28;
/**
 * A pass to a teammate is played firmly, to arrive at a controllable pace: 7 m/s for a
 * short one, rising 0.4 m/s per metre to 12 m/s from 12.5 m. A 10 m pass leaves the foot
 * at about 13 m/s and gets there in 0.85 s (research: short passes 10-15 m/s, arriving in
 * about 0.4-0.8 s; feedback/research-mouse-and-pace.md section 3 and 4). A receiver
 * controls up to 11 + 11 x dribbling m/s (match.ts), so every receiver can take it.
 */
export const receiverArrival = (d: number): number => clamp(6 + 0.4 * d, 7, 12);
/** The fast regime as dv/dt = -(FAST_A + ROLL_FAST_B v), continuous with the slow one at ROLL_FAST_V. */
const FAST_A = ROLL_A + (ROLL_B - ROLL_FAST_B) * ROLL_FAST_V;

/** Under dv/dt = -(a + b v): distance and time to slow from v0 to v1. */
const segDist = (a: number, b: number, v0: number, v1: number): number => (v0 - v1) / b - (a / (b * b)) * Math.log((a + b * v0) / (a + b * v1));
const segTime = (a: number, b: number, v0: number, v1: number): number => Math.log((a + b * v0) / (a + b * v1)) / b;

/** Metres a ball rolling at v0 covers before slowing to vEnd. */
export function rollDistance(v0: number, vEnd: number): number {
  if (v0 <= vEnd) return 0;
  if (v0 <= ROLL_FAST_V) return segDist(ROLL_A, ROLL_B, v0, vEnd);
  if (vEnd >= ROLL_FAST_V) return segDist(FAST_A, ROLL_FAST_B, v0, vEnd);
  return segDist(FAST_A, ROLL_FAST_B, v0, ROLL_FAST_V) + segDist(ROLL_A, ROLL_B, ROLL_FAST_V, vEnd);
}

/** Seconds a ball rolling at v0 takes to slow to vEnd. */
export function rollTime(v0: number, vEnd: number): number {
  if (v0 <= vEnd) return 0;
  if (v0 <= ROLL_FAST_V) return segTime(ROLL_A, ROLL_B, v0, vEnd);
  if (vEnd >= ROLL_FAST_V) return segTime(FAST_A, ROLL_FAST_B, v0, vEnd);
  return segTime(FAST_A, ROLL_FAST_B, v0, ROLL_FAST_V) + segTime(ROLL_A, ROLL_B, ROLL_FAST_V, vEnd);
}

/** Metres a ball rolling at v0 covers in t seconds (it stops for good when its speed reaches 0). */
export function rollTravel(v0: number, t: number): number {
  if (v0 <= 0 || t <= 0) return 0;
  const seg = (a: number, b: number, v: number, tt: number) => {
    const c = v + a / b;
    const tStop = Math.log(c / (a / b)) / b;
    const u = Math.min(tt, tStop);
    return (c * (1 - Math.exp(-b * u))) / b - (a / b) * u;
  };
  if (v0 <= ROLL_FAST_V) return seg(ROLL_A, ROLL_B, v0, t);
  const t1 = segTime(FAST_A, ROLL_FAST_B, v0, ROLL_FAST_V);
  if (t <= t1) return seg(FAST_A, ROLL_FAST_B, v0, t);
  return segDist(FAST_A, ROLL_FAST_B, v0, ROLL_FAST_V) + seg(ROLL_A, ROLL_B, ROLL_FAST_V, t - t1);
}

export interface GroundPassPlan {
  /** Kick speed, m/s, that rolls the ball out to the target at PASS_ARRIVAL_SPEED. */
  speed: number;
  /** Seconds until it gets there. */
  flight: number;
}

/**
 * What it takes to roll a ball `d` metres and have it still going at `arrive` m/s when it
 * gets there. Longer than the ball can go (about 60 m) caps at the hardest kick.
 */
export function groundPassPlan(d: number, arrive = PASS_ARRIVAL_SPEED): GroundPassPlan {
  let lo = arrive;
  let hi = PASS_MAX_SPEED;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (rollDistance(mid, arrive) < d) lo = mid;
    else hi = mid;
  }
  const speed = clamp(hi, arrive + 0.5, PASS_MAX_SPEED);
  return { speed, flight: rollTime(speed, Math.min(arrive, speed)) };
}

/**
 * Pass assist. A teammate is the pass's receiver when the pointer is near him, or near
 * where he is running to: within PASS_ASSIST_R metres, growing by PASS_ASSIST_GROW per
 * metre of pass to at most PASS_ASSIST_MAX (2.5 m at 10 m, 4 m from 25 m: the broadcast
 * camera makes depth hard to judge at range). Or when the pointer is on the line to him,
 * inside PASS_ASSIST_CONE degrees, and between 0.6 and 1.2 times his distance (a click a
 * little short of him or just past him). Research: snap inside a cone of about 25-30
 * degrees (section 3); this one is narrower so balls into space stay possible.
 */
export const PASS_ASSIST_R = 1.5;
export const PASS_ASSIST_GROW = 0.1;
export const PASS_ASSIST_MAX = 4;
export const PASS_ASSIST_CONE = 12;
const CONE_COS = Math.cos((PASS_ASSIST_CONE * Math.PI) / 180);

export const assistRadius = (passLen: number): number => clamp(PASS_ASSIST_R + PASS_ASSIST_GROW * passLen, PASS_ASSIST_R, PASS_ASSIST_MAX);

/** Where a teammate will be when a firm pass from `from` reaches him. */
export function leadPoint(from: Vec, m: MatchPlayer): Vec {
  let lead = m.pos;
  if (len(m.vel) > 0.8) {
    // Two passes of the fixed point settle it.
    for (let k = 0; k < 2; k++) {
      const d = dist(from, lead);
      const t = Math.min(groundPassPlan(d, receiverArrival(d)).flight, 1.5);
      lead = clampToPitch(add(m.pos, scale(m.vel, t)), 0.5);
    }
  }
  return lead;
}

/** The teammate the assist gives a pass from `from` aimed at `aim`, or -1 (see PASS_ASSIST_R). */
export function assistReceiver(s: MatchState, p: MatchPlayer, from: Vec, aim: Vec): number {
  let receiver = -1;
  const toAim = sub(aim, from);
  const dAim = len(toAim);
  const radius = assistRadius(dAim);
  let bestErr = Infinity;
  for (const m of s.players) {
    // Not to a teammate who is down for longer than the pass takes.
    if (m.team !== p.team || m.i === p.i || m.sentOff || m.stun > 30) continue;
    const lead = leadPoint(from, m);
    const near = Math.min(dist(aim, m.pos), dist(aim, lead));
    let err = Infinity;
    if (near < radius) err = near / radius;
    else if (dAim > 1) {
      const toLead = sub(lead, from);
      const dLead = len(toLead);
      const cos = dLead > 1 ? (toAim.x * toLead.x + toAim.y * toLead.y) / (dAim * dLead) : -1;
      if (cos > CONE_COS && dAim > 0.6 * dLead && dAim < 1.2 * dLead) err = 1 + (1 - cos) / (1 - CONE_COS);
    }
    // A keeper is only played to on purpose (pointer right on him).
    if (m.role === 'GK' && near > PASS_ASSIST_R) err = Infinity;
    if (err < bestErr) {
      bestErr = err;
      receiver = m.i;
    }
  }
  return receiver;
}

/** A firm pass to a teammate's feet, or to where he will be: what pointerPass does once the assist has picked him. */
export function passTo(s: MatchState, m: MatchPlayer): { target: Vec; receiver: number; speed: number } {
  const target = leadPoint(s.ball.pos, m);
  const d = dist(s.ball.pos, target);
  return { target, receiver: m.i, speed: groundPassPlan(d, receiverArrival(d)).speed };
}

/**
 * A human pass in pointer mode. When the assist finds a teammate (see PASS_ASSIST_R), the
 * ball goes to his feet, or to where he will be if he is running, firmly enough to get
 * there quickly (receiverArrival). Otherwise it goes to the grass under the pointer and
 * slows to PASS_ARRIVAL_SPEED there (receiver -1): through balls into space.
 */
export function pointerPass(s: MatchState, p: MatchPlayer, aim: Vec): { target: Vec; receiver: number; speed: number } {
  const ball = s.ball.pos;
  const receiver = assistReceiver(s, p, ball, aim);
  let target = receiver >= 0 ? leadPoint(ball, s.players[receiver]) : clampToPitch(aim, 0.5);
  // A pointer on top of the ball: play it a couple of metres the way the player faces.
  if (dist(ball, target) < 2) {
    const way = norm(sub(target, ball));
    target = clampToPitch(add(ball, scale(way.x === 0 && way.y === 0 ? p.facing : way, 2)), 0.5);
  }
  const d = dist(ball, target);
  return { target, receiver, speed: groundPassPlan(d, receiver >= 0 ? receiverArrival(d) : PASS_ARRIVAL_SPEED).speed };
}

// ---------------------------------------------------------------------------
// Goalkeeper's long kick

/** A punt (from the hands) or long goal kick reaches 30 m at the lightest press, 62 m at full power. */
export const PUNT_MIN_RANGE = 30;
export const PUNT_RANGE_GAIN = 32;
export const puntRange = (power: number): number => PUNT_MIN_RANGE + PUNT_RANGE_GAIN * clamp(power, 0, 1);

/** Where and how a keeper's long kick flies: lands on the target if it is in range, else at the end of the range that way. */
export function puntPlan(from: Vec, target: Vec, power: number): ChipPlan {
  const to = sub(target, from);
  const d = clamp(Math.min(len(to), puntRange(power)), 12, 62);
  const flight = clamp(1.2 + 0.03 * d, 1.5, 3.1);
  return lob(from, len(to) < 1e-6 ? { x: 1, y: 0 } : to, d, flight);
}

/**
 * What a key-scheme pass toward `aim` does right now: the teammate closest to
 * the direction of travel gets it, to feet. (The pointer scheme uses pointerPass.)
 */
export function humanPass(s: MatchState, p: MatchPlayer, aim: Vec): { target: Vec; receiver: number } {
  return resolvePassTarget(s, p, aim);
}
