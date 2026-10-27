// Shared kick planning for human input, the renderer's previews and the CPU.
// Pure functions of state: no mutation, no rng.

import { resolvePassTarget } from './ai.ts';
import { AIR_DRAG, CHIP_Z0, GRAVITY, ROLL_A, ROLL_B, ROLL_FAST_B, ROLL_FAST_V } from './constants.ts';
import { clampToPitch } from './field.ts';
import type { MatchPlayer, MatchState } from './types.ts';
import { add, clamp, dist, dot, len, norm, scale, sub, type Vec } from './vec.ts';

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

/** A click up to this far ahead of a running team-mate, along his run, is a ball into his path. */
export const THROUGH_AHEAD = 14;

/**
 * Is `aim` ahead of team-mate `m` on his run, a ball into his path? How far off his line it is as a
 * share of the room allowed (2 m, plus a quarter of how far ahead), or Infinity.
 */
function intoPath(m: MatchPlayer, aim: Vec): number {
  const v = len(m.vel);
  if (v < 2.5) return Infinity;
  const run = scale(m.vel, 1 / v);
  const to = sub(aim, m.pos);
  const ahead = dot(to, run);
  if (ahead < 1 || ahead > THROUGH_AHEAD) return Infinity;
  const off = Math.abs(to.x * run.y - to.y * run.x);
  const room = 2 + 0.25 * ahead;
  return off < room ? off / room : Infinity;
}

/** The teammate the assist gives a pass from `from` aimed at `aim`, or -1 (see PASS_ASSIST_R). */
export function assistReceiver(s: MatchState, p: MatchPlayer, from: Vec, aim: Vec): number {
  return assistPick(s, p, from, aim).receiver;
}

/** assistReceiver, and whether he was picked for a ball into his path (played to the pointer, timed for him) rather than to him. */
function assistPick(s: MatchState, p: MatchPlayer, from: Vec, aim: Vec): { receiver: number; into: boolean } {
  let receiver = -1;
  let into = false;
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
    // Past all that, a click into the path of a man making a run is for him.
    const path = err === Infinity && m.role !== 'GK' ? intoPath(m, aim) : Infinity;
    if (path < Infinity) err = 2 + path;
    if (err < bestErr) {
      bestErr = err;
      receiver = m.i;
      into = path < Infinity;
    }
  }
  return { receiver, into };
}

/** The pace a ball rolled `d` metres should still have when it gets there, to arrive in about `t` seconds. */
function timedArrival(d: number, t: number): number {
  let lo = PASS_ARRIVAL_SPEED;
  let hi = THROUGH_MAX_ARRIVAL;
  if (groundPassPlan(d, lo).flight <= t) return lo;
  if (groundPassPlan(d, hi).flight >= t) return hi;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (groundPassPlan(d, mid).flight > t) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** A ball into a runner's path is never rolled faster than this as it reaches the pointer. */
const THROUGH_MAX_ARRIVAL = 14;

/** A pointer closer than this (m) to the ball gives a kick no direction. */
export const KICK_NEAR = 2.5;

/**
 * Where a kick aimed at `aim` goes. A pointer by the ball gives no direction: he ran to it and
 * stopped short, so it is usually just behind the ball, and a kick toward it would go back through
 * his own legs. Then it goes `far` metres the way he faces (the way the ball sits from him).
 */
export function kickAim(ball: Vec, p: MatchPlayer, aim: Vec, far: number): Vec {
  return dist(ball, aim) < KICK_NEAR ? add(ball, scale(p.facing, far)) : aim;
}

/** A firm pass to a teammate's feet, or to where he will be: what pointerPass does once the assist has picked him. */
/** `lead`: play it to where he will be if he is running (false: to his feet, e.g. a man who stops when a restart is ready). */
export function passTo(s: MatchState, m: MatchPlayer, lead = true): { target: Vec; receiver: number; speed: number } {
  const target = lead ? leadPoint(s.ball.pos, m) : { ...m.pos };
  const d = dist(s.ball.pos, target);
  return { target, receiver: m.i, speed: groundPassPlan(d, receiverArrival(d)).speed };
}

/** A firm pass to team-mate `m`, played to `at` (where he is going), arriving at a controllable pace. */
export function passToPoint(s: MatchState, m: MatchPlayer, at: Vec): { target: Vec; receiver: number; speed: number } {
  const target = { ...at };
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
  const { receiver, into } = assistPick(s, p, ball, aim);
  if (into) {
    // Into his path: to the pointer, timed to get there as he does at the pace he is running.
    const m = s.players[receiver];
    const target = clampToPitch(aim, 0.5);
    const d = dist(ball, target);
    return { target, receiver, speed: groundPassPlan(d, timedArrival(d, dist(m.pos, target) / len(m.vel))).speed };
  }
  let target = receiver >= 0 ? leadPoint(ball, s.players[receiver]) : clampToPitch(kickAim(ball, p, aim, 2), 0.5);
  // A teammate right by the ball: play it a couple of metres his way.
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

// ---------------------------------------------------------------------------
// Shots

/** How hard a shot is struck (m/s) for a power 0..1 and a shooting attribute 0..1. */
export const shotSpeed = (power: number, shooting: number): number => (13 + 17 * power) * (0.8 + 0.3 * shooting);

/** Height a lifted shot leaves the foot at. */
export const SHOT_Z0 = 0.05;

/** The human's shot power runs from this (a quick click) to 1 (a full hold). */
export const HUMAN_SHOT_MIN = 0.55;

/** How high (m) a human's shot of this power comes in at the goal line: 0.3 m for a soft one, up to 2.0 m at full power. */
export function humanShotHeight(power: number): number {
  const k = clamp((power - HUMAN_SHOT_MIN) / (1 - HUMAN_SHOT_MIN), 0, 1);
  return 0.3 + 1.7 * Math.pow(k, 1.2);
}

/**
 * The lift (initial vz, m/s) that puts a human shot at a height on the goal line that rises with
 * the power: a quick click stays low (about 0.3 m), a full hold rises to about 2 m. match.ts adds
 * a vertical scatter that grows with power and falls with shooting, so a poor shooter's blast
 * can go over.
 */
export function humanShotLift(from: Vec, target: Vec, goalX: number, power: number, shooting: number): number {
  const h = humanShotHeight(power);
  // Planned to where the shot's line crosses the goal line (the pointer is often short of it while
  // dribbling), or to the pointer if the shot doesn't head for the line.
  const dx = target.x - from.x;
  const toLine = goalX - from.x;
  const d = Math.abs(dx) > 1e-6 && Math.sign(dx) === Math.sign(toLine) ? dist(from, target) * (toLine / dx) : dist(from, target);
  const t = Math.max(0.15, d / shotSpeed(power, shooting));
  return Math.max(0, (h - SHOT_Z0 + 0.5 * GRAVITY * t * t) / t);
}

// ---------------------------------------------------------------------------
// Set-piece strikes: curl and dip

/** Sideways bend (m/s^2) of a full-curl strike by a perfect striker: about 3 m over a 22 m free kick. */
export const CURL_A = 8;
/** Most topspin a strike can carry, as a downward acceleration (m/s^2) on top of gravity. Struck too hard to come down in time, it goes over. */
export const DIP_MAX = 14;
/** A strike over a wall plans to pass it this high: over a jumping wall's heads (HEAD_Z plus the jump). */
export const WALL_CLEAR = 3.2;
/** A strike whose line passes a wall man closer than this (m) still goes over the wall, not past it. */
export const WALL_NEAR = 3;
/** A curled strike whose line passes a wall man by more than this (m, centre to centre) goes round him, not over. */
export const WALL_MISS = 0.75;

/** Seconds for a ball struck along the ground or through the air at `v` (m/s, with AIR_DRAG) to cover `d` metres; capped at 3. */
export function airTime(v: number, d: number): number {
  const q = 1 - (AIR_DRAG * d) / Math.max(v, 1e-6);
  return q <= 0.05 ? 3 : Math.min(3, -Math.log(q) / AIR_DRAG);
}

export interface StrikePlan {
  /** Unit vector the ball sets off along (out to the side for a curled strike, so the bend brings it back). */
  dir: Vec;
  /** How hard it is struck (m/s): the power's pace, or less to get it over a wall and down (setPieceStrike). */
  speed: number;
  /** Left-hand normal of the line to the target: the way `side` bends it. */
  normal: Vec;
  /** Initial vertical speed from SHOT_Z0. */
  vz: number;
  /** Bend (m/s^2 along `normal`) and dip (m/s^2 downward). */
  side: number;
  top: number;
  /** Seconds to the target. */
  flight: number;
  /** Planned over the wall (else round it, or there is no wall in the way). */
  over: boolean;
}

/**
 * A free kick struck at `target` (on the goal line) with the pace of `speed`, with `curl` -1..1 (positive bends
 * it to the kicker's left). It sets off to the other side so the bend brings it back onto the target. With a man
 * of the wall (`wall`, their positions) on or near its line it is struck over them: up to WALL_CLEAR at the wall,
 * then dipping with topspin to come in under the bar. The pace is taken off it as far as that needs: a quick
 * strike (power at HUMAN_SHOT_MIN) is the fastest that dips in, a full one up to OVER_PACE times that, too hard to
 * dip (DIP_MAX) so it clears the wall and sails on over. A line well clear of the wall is a shot (the harder, the
 * higher). Pure: the caller adds the striker's error.
 */
export function setPieceStrike(from: Vec, target: Vec, speed: number, curl: number, shooting: number, power: number, wall: Vec[]): StrikePlan {
  const kp = clamp((power - HUMAN_SHOT_MIN) / (1 - HUMAN_SHOT_MIN), 0, 1);
  let plan = strikeAt(from, target, speed, curl, shooting, kp, wall);
  if (plan.over && plan.dipNeeded > DIP_MAX) {
    // Over a wall he takes the pace off it to get it up and down: a quick strike is the fastest that still
    // dips in under the bar, a full one up to OVER_PACE times that (more pace past the keeper, and more
    // chance it sails over).
    let lo = 8;
    let hi = speed;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (strikeAt(from, target, mid, curl, shooting, kp, wall).dipNeeded > DIP_MAX) hi = mid;
      else lo = mid;
    }
    plan = strikeAt(from, target, Math.min(speed, lo * (1 + (OVER_PACE - 1) * kp)), curl, shooting, kp, wall);
  }
  return plan;
}

/** A full-power strike over a wall goes this many times the pace that just dips under the bar (setPieceStrike). */
export const OVER_PACE = 1.15;

function strikeAt(from: Vec, target: Vec, speed: number, curl: number, shooting: number, kp: number, wall: Vec[]): StrikePlan & { dipNeeded: number } {
  const k = AIR_DRAG;
  const side = clamp(curl, -1, 1) * CURL_A * (0.6 + 0.4 * shooting);
  const d = Math.max(1, dist(from, target));
  const base = norm(sub(target, from));
  const normal = { x: -base.y, y: base.x };
  const reach = (t: number) => (1 - Math.exp(-k * t)) / k; // metres travelled per m/s of starting speed
  const bend = (t: number) => (side / k) * (t - reach(t));
  // Setting off out to the side takes some of its pace along the line: solve the flight time with what is left.
  let T = airTime(speed, d);
  let lat0 = 0;
  let fwd = speed;
  for (let i = 0; i < 3; i++) {
    lat0 = clamp(-bend(T) / reach(T), -0.5 * speed, 0.5 * speed);
    fwd = Math.sqrt(speed * speed - lat0 * lat0);
    T = airTime(fwd, d);
  }
  const dir = norm(add(scale(base, fwd), scale(normal, lat0)));
  const lateral = (t: number) => lat0 * reach(t) + bend(t);
  // Is there a wall in front, does its line meet it, and when does it get there (the nearest man)?
  let tw = Infinity;
  let meets = false;
  let nearest = Infinity;
  for (const w of wall) {
    const along = dot(sub(w, from), base);
    if (along <= 0.5 || along >= d) continue;
    const t = airTime(fwd, along);
    const miss = Math.abs(lateral(t) - dot(sub(w, from), normal));
    if (miss < WALL_MISS) meets = true;
    nearest = Math.min(nearest, miss);
    tw = Math.min(tw, t);
  }
  // With a wall in front it goes over it, dipping into the goal over the men in the box (bent, if curled,
  // round the keeper or the end of the wall). Struck along a line well clear of the wall, it is a shot.
  const over = tw < Infinity && (meets || nearest < WALL_NEAR);
  if (!over || tw >= T - 0.05) {
    const h = 0.3 + 1.7 * Math.pow(kp, 1.2);
    return { dir, normal, speed, vz: Math.max(0, (h - SHOT_Z0 + 0.5 * GRAVITY * T * T) / T), side, top: 0, flight: T, over: false, dipNeeded: 0 };
  }
  // Over: through WALL_CLEAR at the wall and down to `h` at the line (under the bar), solving for the dip.
  const h = 1.8 + 0.4 * kp;
  const c = WALL_CLEAR - SHOT_Z0;
  const hh = h - SHOT_Z0;
  const G = ((c * T) / tw - hh) / (0.5 * T * (T - tw));
  const top = clamp(G - GRAVITY, 0, DIP_MAX);
  const g = GRAVITY + top;
  // Too hard to come down in time: it still clears the wall, and goes over.
  const vz = G - GRAVITY > DIP_MAX ? (c + 0.5 * g * tw * tw) / tw : (hh + 0.5 * g * T * T) / T;
  return { dir, normal, speed, vz, side, top, flight: T, over: true, dipNeeded: G - GRAVITY };
}

/** Where a strike planned from `from` goes, `n` points over `seconds` (or its flight to the target), with its bend and dip: for drawing the aim. */
export function strikePath(from: Vec, plan: StrikePlan, n = 24, seconds = plan.flight): { x: number; y: number; z: number }[] {
  const k = AIR_DRAG;
  const pts: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (seconds * i) / n;
    const r = (1 - Math.exp(-k * t)) / k;
    const bend = (plan.side / k) * (t - r);
    const z = SHOT_Z0 + plan.vz * t - 0.5 * (GRAVITY + plan.top) * t * t;
    pts.push({ x: from.x + plan.dir.x * plan.speed * r + plan.normal.x * bend, y: from.y + plan.dir.y * plan.speed * r + plan.normal.y * bend, z: Math.max(0, z) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Set-piece deliveries: a cross from a corner or a free kick

/** How far (m) a fully curled cross swings off the straight line, for a perfect passer (an inswinger or outswinger). */
export const DELIVERY_BEND = 6;

/**
 * A lofted set-piece delivery (a corner or a free-kick cross): it comes down on `target`, wherever that is,
 * instead of at the end of the open-play loft's range (loftPlan). `hold` 0..1 picks the ball: a quick press is
 * driven (about 1.7 s over 30 m, up to about 3.5 m); a full hold floats it, high and slow (about 2.5 s, 7.5 m up). `curl` -1..1
 * bends it (an inswinger or an outswinger), setting off to the other side so it still lands on the target.
 */
export function deliveryPlan(from: Vec, target: Vec, hold: number, curl: number, passing: number): StrikePlan & { landing: Vec } {
  const k = AIR_DRAG;
  const h = clamp(hold, 0, 1);
  const d = clamp(dist(from, target), 3, 55);
  const base = norm(sub(target, from));
  const normal = { x: -base.y, y: base.x };
  const T = clamp(1 + 0.022 * d + h * (0.5 + 0.01 * d), 0.8, 2.8);
  const reach = (1 - Math.exp(-k * T)) / k;
  // Full curl swings it about DELIVERY_BEND across, however long it hangs.
  const side = (clamp(curl, -1, 1) * DELIVERY_BEND * (0.6 + 0.4 * passing)) / ((T - reach) / k);
  const bend = (side / k) * (T - reach);
  const fwd = d / reach;
  const lat0 = -bend / reach;
  const speed = Math.hypot(fwd, lat0);
  const dir = norm(add(scale(base, fwd), scale(normal, lat0)));
  const vz = (GRAVITY * T) / 2 - CHIP_Z0 / T;
  return { dir, normal, speed, vz, side, top: 0, flight: T, over: false, landing: add(from, scale(base, d)) };
}
