// Goal celebrations, drawn only. For the 2.2 s the sim holds play after a goal (GOAL_PAUSE) its
// players just slow to a stop where they are, so the scorer celebrated alone on the spot while his
// team-mates clapped where they stood. Here the scorer runs off toward the nearest corner flag (his
// celebration pose plays as he goes: the aeroplane, a fist, a knee slide at the end of the run) and
// the nearest few team-mates run to where he stops and gather round him. Nothing here feeds back
// into the match: it only changes where those players are drawn, timed by sim ticks so an instant
// replay shows the same, and not at all with reduced motion or after an own goal.

import { PITCH_H, PITCH_W } from '../../sim/constants.ts';
import type { GoalEvent, MatchState } from '../../sim/types.ts';
import type { Vec } from '../../sim/vec.ts';
import type { SimBody } from './player3d.ts';

/** The scorer runs this far at most toward the nearest corner flag, stopping this far short of it, m. */
export const RUN_OFF = 9;
export const FLAG_CLEAR = 4;
/** He sets off this long after the goal, s, at this speed, m/s. */
export const RUN_START = 0.1;
export const RUN_SPEED = 6.5;
/** Up to this many team-mates join him, from within this far of where he stops (they must get there in the pause), m. */
export const MOB_MAX = 3;
export const MOB_RANGE = 13;
/** They set off this long after the goal, s, at this speed, m/s (a sprint). */
export const MOB_START = 0.2;
export const MOB_SPEED = 7.5;
/** And stop this far from him, m, no closer than this to each other. */
export const MOB_RING = 1.15;
export const MOB_GAP = 0.8;

export interface MobRunner {
  i: number;
  /** Where he was when the ball went in. */
  from: Vec;
  /** Which side of the scorer he ends up on (radians, sim x/y), and when he sets off (s after the goal). */
  angle: number;
  delay: number;
}

export interface MobPlan {
  tick: number;
  scorer: number;
  /** The scorer's run-off, from where he was to where he stops. */
  run: { from: Vec; to: Vec };
  runners: MobRunner[];
}

/** Where the scorer stops: toward the nearest corner flag of the goal he scored in, RUN_OFF at most, FLAG_CLEAR short of it. */
function runOffEnd(from: Vec, goalX: number): Vec {
  const flag = { x: goalX, y: from.y < PITCH_H / 2 ? 0 : PITCH_H };
  const dx = flag.x - from.x;
  const dy = flag.y - from.y;
  const l = Math.hypot(dx, dy);
  const run = Math.max(0, Math.min(RUN_OFF, l - FLAG_CLEAR));
  return l > 1e-6 ? { x: from.x + (dx / l) * run, y: from.y + (dy / l) * run } : { ...from };
}

/** Who runs where for this goal, from the state as the goal is scored (or null: an own goal, no scorer, reduced motion). */
export function planMob(s: MatchState, goal: GoalEvent, reduced: boolean): MobPlan | null {
  if (reduced || goal.ownGoal || goal.player < 0) return null;
  const sc = s.players[goal.player];
  if (!sc || sc.sentOff || sc.team !== goal.team) return null;
  // The goal he scored in: the end the ball is at.
  const goalX = s.ball.pos.x < PITCH_W / 2 ? 0 : PITCH_W;
  const from = { x: sc.pos.x, y: sc.pos.y };
  const to = runOffEnd(from, goalX);
  const near = s.players
    .filter((p) => p.team === sc.team && p.i !== sc.i && p.role !== 'GK' && !p.sentOff)
    .map((p) => ({ p, d: Math.hypot(p.pos.x - to.x, p.pos.y - to.y) }))
    .filter((q) => q.d <= MOB_RANGE)
    .sort((a, b) => a.d - b.d)
    .slice(0, MOB_MAX);
  // Each ends up on the side he comes from, spread so no two stand closer than MOB_GAP.
  const minAng = 2 * Math.asin(MOB_GAP / 2 / MOB_RING);
  const runners = near
    .map(({ p }, k) => ({ i: p.i, from: { x: p.pos.x, y: p.pos.y }, angle: Math.atan2(p.pos.y - to.y, p.pos.x - to.x), delay: MOB_START + 0.12 * k }))
    .sort((a, b) => a.angle - b.angle);
  for (let pass = 0; pass < 4; pass++) {
    for (let k = 0; k < runners.length; k++) {
      const a = runners[k];
      const b = runners[(k + 1) % runners.length];
      if (a === b) continue;
      let gap = b.angle - a.angle;
      if (k === runners.length - 1) gap += Math.PI * 2;
      if (gap < minAng) {
        const push = (minAng - gap) / 2;
        a.angle -= push;
        b.angle += push;
      }
    }
  }
  return { tick: goal.tick, scorer: sc.i, run: { from, to }, runners };
}

/** A run from `from` to `to` at `speed`, setting off at `delay`, `t` s after the goal: fills `out`, facing `look` once there. */
function runBody(from: Vec, to: Vec, speed: number, delay: number, t: number, look: Vec, out: SimBody): SimBody {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  const run = Math.max(0, Math.min(l, (t - delay) * speed));
  const ux = l > 1e-6 ? dx / l : 0;
  const uy = l > 1e-6 ? dy / l : 0;
  const going = t > delay && run < l;
  out.pos = { x: from.x + ux * run, y: from.y + uy * run };
  out.vel = going ? { x: ux * speed, y: uy * speed } : { x: 0, y: 0 };
  // Running: facing where he runs. There: facing `look`.
  const fx = going ? ux : look.x - out.pos.x;
  const fy = going ? uy : look.y - out.pos.y;
  const fl = Math.hypot(fx, fy) || 1;
  out.facing = { x: fx / fl, y: fy / fl };
  out.sprinting = going;
  return out;
}

/** Where the scorer is drawn `t` seconds after the goal: running off, then facing back across the pitch. */
export function scorerBody(plan: MobPlan, t: number, out: SimBody): SimBody {
  const { from, to } = plan.run;
  return runBody(from, to, RUN_SPEED, RUN_START, t, { x: PITCH_W / 2, y: PITCH_H / 2 }, out);
}

/** Where a runner is drawn `t` seconds after the goal: from where he was to his place by the scorer, then facing him. */
export function mobBody(plan: MobPlan, r: MobRunner, t: number, out: SimBody): SimBody {
  const c = plan.run.to;
  const to = { x: c.x + Math.cos(r.angle) * MOB_RING, y: c.y + Math.sin(r.angle) * MOB_RING };
  return runBody(r.from, to, MOB_SPEED, r.delay, t, c, out);
}

/** Where the scorer is drawn, for framing the celebration (the close camera follows him on his run). */
export function scorerAt(plan: MobPlan, t: number): Vec {
  return scorerBody(plan, t, { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 } }).pos;
}
