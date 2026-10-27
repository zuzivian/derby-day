// How hard a kick will go, as one gauge shared by the 3D aim wedge and the
// HUD power bar, so the two always agree. Pure: no DOM, no three.js.
//
//   fill  0..1, how much of the wedge (and the bar) is lit
//   band  'green' (the sweet spot), 'amber' (firm, or a loft falling short), 'red' (over-hit)
//   tick  0..1, where the sweet spot ends on the bar
//
// Shots: power is SHOT_MIN for a click up to 1 for a full hold; the sim's
// aiming error grows with power squared (match.ts: 0.02 + 0.12 * power²), so
// past about 0.85 it starts to spray. Passes: the pace a click would hit it at,
// against the research brief's bands (§4: 10–15 m/s short, 18–25 m/s long; a
// ground pass over about 24 m/s is hard to take). Lofts: how much of the
// distance to the pointer the hold reaches.

import { passSpeed } from '../sim/ai.ts';
import { oppGoal } from '../sim/field.ts';
import { AIR_DRAG, BOUNCE_DAMP, BOUNCE_KEEP, DT, GOAL_BAR_H, GOAL_W, GRAVITY, PITCH_H, rollDecel } from '../sim/constants.ts';
import { humanPass, humanShotLift, kickAim, loftRange, pointerPass, SHOT_Z0, shotSpeed } from '../sim/kicks.ts';
import type { MatchPlayer, MatchState } from '../sim/types.ts';
import type { Vec } from '../sim/vec.ts';
import type { RenderExtras } from './render.ts';

export type PowerBand = 'green' | 'amber' | 'red';

export interface Gauge {
  fill: number;
  band: PowerBand;
  /** Where the sweet spot ends, 0..1 along the bar. */
  tick: number;
  /** What the bar measures, for its label on the HUD. */
  kind: 'pass' | 'loft' | 'shot';
}

/** Shot power at which the strike starts to fly off target. */
export const SHOT_SWEET = 0.85;
/** Above this a shot is over-hit (red). */
export const SHOT_WILD = 0.93;
/** Ground passes: the hardest kick the sim plays (kicks.ts PASS_MAX_SPEED), the end of the bar. */
export const PASS_FULL = 28;
/** Pace bands for a ground pass, m/s. */
export const PASS_FIRM = 18;
export const PASS_HARD = 24;

export const GAUGE_COLORS: Record<PowerBand, string> = { green: '#46d36a', amber: '#ffb020', red: '#ff4a32' };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function shotGauge(power: number): Gauge {
  const band: PowerBand = power > SHOT_WILD ? 'red' : power > SHOT_SWEET ? 'amber' : 'green';
  return { fill: clamp01(power), band, tick: SHOT_SWEET, kind: 'shot' };
}

/** A ground pass kicked at `speed` m/s. */
export function passGauge(speed: number): Gauge {
  const band: PowerBand = speed > PASS_HARD ? 'red' : speed > PASS_FIRM ? 'amber' : 'green';
  return { fill: clamp01(speed / PASS_FULL), band, tick: PASS_FIRM / PASS_FULL, kind: 'pass' };
}

/**
 * A lofted ball: `hold` 0..1, `reach` metres it would carry, `want` metres to the pointer. Green
 * once it reaches the pointer, amber while it would fall short.
 */
export function loftGauge(hold: number, reach: number, want: number): Gauge {
  const short = reach < want - 0.5;
  return { fill: clamp01(Math.max(0.04, hold)), band: short ? 'amber' : 'green', tick: 1, kind: 'loft' };
}

/**
 * The gauge for what the human would kick right now, or null when they don't have the ball (or no
 * human is playing): a charging shot or loft from `x.armed`, else the pace of a plain click pass
 * (pointer) or Space pass (keys, toward where the player faces).
 */
export function kickGauge(s: MatchState, x: RenderExtras): Gauge | null {
  const me: 0 | 1 = x.team ?? (s.humans[0] || !s.humans[1] ? 0 : 1);
  const ci = s.humans[me] ? s.controlled[me] : -1;
  if (ci < 0) return null;
  const p = s.players[ci];
  const ready = s.phase === 'play' || (s.phase === 'restart' && s.restart?.stage === 'ready');
  if (s.ball.owner !== p.i || !ready) return null;
  const pointer = x.showCursor && x.cursor ? x.cursor : null;
  const aim = pointer ?? { x: p.pos.x + p.facing.x * 14, y: p.pos.y + p.facing.y * 14 };
  const a = x.armed;
  if (a?.kind === 'shot') return shotGauge(a.power);
  if (a?.kind === 'loft') {
    const to = pointer ? kickAim(s.ball.pos, p, pointer, 40) : aim;
    const want = Math.hypot(to.x - s.ball.pos.x, to.y - s.ball.pos.y);
    return loftGauge(a.power, loftRange(a.power), want);
  }
  // The pace the sim will really kick it at: pointerPass's own speed (firm to a teammate, weighted
  // to the spot into space); a Space pass goes at the CPU's pace for the distance (match.ts applyAction).
  if (pointer) return passGauge(pointerPass(s, p, pointer).speed);
  const target = humanPass(s, p, aim).target;
  return passGauge(passSpeed(Math.hypot(target.x - s.ball.pos.x, target.y - s.ball.pos.y), p.attrs.passing));
}

/** Where a human's shot crosses the goal line: `y` across the pitch, `z` the height (m) it arrives at, `d` the metres of flight. */
export interface GoalCross {
  y: number;
  z: number;
  d: number;
  /** Between the posts and under the bar. */
  inMouth: boolean;
}

/** Past this (m) from the ball to the goal line no crosshair is drawn: it is not a shot. */
export const GOAL_CROSS_RANGE = 45;
/** A shot this far (m) outside a post, or this far (m) over the bar, is drawn; further is a plain miss and shows nothing. */
export const GOAL_CROSS_SLACK = 4;

/**
 * The height (m) a ball struck at `speed` with initial vertical speed `vz` is at when it has gone `d` metres
 * along the ground, flown tick by tick as match.ts does (drag, gravity, bounces, then the roll); null if it stops short.
 */
export function shotHeightAt(speed: number, vz: number, d: number): number | null {
  let v = speed;
  let z = SHOT_Z0;
  let x = 0;
  for (let i = 0; i < 900 && x < d; i++) {
    if (z > 0 || vz > 0) {
      vz -= GRAVITY * DT;
      z += vz * DT;
      v *= 1 - AIR_DRAG * DT;
      if (z <= 0) {
        z = 0;
        if (vz < -1.5) {
          vz = -vz * BOUNCE_DAMP;
          v *= BOUNCE_KEEP;
        } else vz = 0;
      }
    } else v = Math.max(0, v - rollDecel(v) * DT);
    if (v < 0.5) return null;
    x += v * DT;
  }
  return z;
}

/**
 * Where the shot from `from` along the line to `target` (what kickAim gives, the pointer) crosses
 * the line at `goalX`, and how high it comes in there at `power`: humanShotLift's own plan (the same
 * lift and pace the sim kicks it with, flown as the sim flies it, so a long shot arrives lower than
 * the plan's nominal height, and may bounce first). Null when the line does not head for that goal line, or
 * the crossing is out of range or well wide or high of the goal. Pure.
 */
export function goalCross(from: Vec, target: Vec, goalX: number, power: number, shooting: number): GoalCross | null {
  const dx = target.x - from.x;
  const toLine = goalX - from.x;
  if (Math.abs(dx) < 1e-6 || Math.sign(dx) !== Math.sign(toLine)) return null;
  const f = toLine / dx;
  const y = from.y + (target.y - from.y) * f;
  const d = Math.hypot(dx, target.y - from.y) * f;
  if (d > GOAL_CROSS_RANGE || Math.abs(y - PITCH_H / 2) > GOAL_W / 2 + GOAL_CROSS_SLACK) return null;
  const z = shotHeightAt(shotSpeed(power, shooting), humanShotLift(from, target, goalX, power, shooting), d);
  if (z === null) return null;
  if (z > GOAL_BAR_H + GOAL_CROSS_SLACK) return null;
  return { y, z, d, inMouth: Math.abs(y - PITCH_H / 2) <= GOAL_W / 2 && z <= GOAL_BAR_H };
}

/**
 * The goal crossing of the shot `p` would take at the pointer `aim` in open play (humanIntent's shoot
 * branch: kickAim, then the lift for `power`), or null for a keeper (he punts) or a line that is not
 * a shot at their goal. `power` is the charge (x.armed) or SHOT_MIN for a plain click.
 */
export function shotGoalCross(s: MatchState, p: MatchPlayer, aim: Vec, power: number): GoalCross | null {
  if (p.role === 'GK' || s.phase !== 'play') return null;
  return goalCross(s.ball.pos, kickAim(s.ball.pos, p, aim, 20), oppGoal(s, p.team).x, power, p.attrs.shooting);
}
