// Goal celebrations, drawn only. For the 2.2 s the sim holds play after a goal (GOAL_PAUSE) its
// players just slow to a stop where they are, so the scorer celebrated alone while his team-mates
// clapped on the spot. Here the nearest few run to him and gather round. Nothing here feeds back
// into the match: it only changes where those players are drawn, timed by sim ticks so an instant
// replay shows the same, and not at all with reduced motion or after an own goal.

import type { GoalEvent, MatchState } from '../../sim/types.ts';
import type { Vec } from '../../sim/vec.ts';
import type { SimBody } from './player3d.ts';

/** Up to this many team-mates join the scorer, from within this far (they must get there in the pause), m. */
export const MOB_MAX = 3;
export const MOB_RANGE = 14;
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
  runners: MobRunner[];
}

/** Who runs to the scorer of this goal, from the state as the goal is scored (or null: an own goal, nobody near, reduced motion). */
export function planMob(s: MatchState, goal: GoalEvent, reduced: boolean): MobPlan | null {
  if (reduced || goal.ownGoal || goal.player < 0) return null;
  const sc = s.players[goal.player];
  if (!sc || sc.sentOff || sc.team !== goal.team) return null;
  const near = s.players
    .filter((p) => p.team === sc.team && p.i !== sc.i && p.role !== 'GK' && !p.sentOff)
    .map((p) => ({ p, d: Math.hypot(p.pos.x - sc.pos.x, p.pos.y - sc.pos.y) }))
    .filter((q) => q.d <= MOB_RANGE)
    .sort((a, b) => a.d - b.d)
    .slice(0, MOB_MAX);
  if (!near.length) return null;
  // Each ends up on the side he comes from, spread so no two stand closer than MOB_GAP.
  const minAng = 2 * Math.asin(MOB_GAP / 2 / MOB_RING);
  const runners = near
    .map(({ p }, k) => ({ i: p.i, from: { x: p.pos.x, y: p.pos.y }, angle: Math.atan2(p.pos.y - sc.pos.y, p.pos.x - sc.pos.x), delay: MOB_START + 0.12 * k }))
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
  return { tick: goal.tick, scorer: sc.i, runners };
}

/**
 * Where a runner is drawn `t` seconds after the goal, running from where he was to his place by the
 * scorer (at `scorer` now): fills `out` (pos, vel, facing) for the player model.
 */
export function mobBody(r: MobRunner, scorer: Vec, t: number, out: SimBody): SimBody {
  const tx = scorer.x + Math.cos(r.angle) * MOB_RING;
  const ty = scorer.y + Math.sin(r.angle) * MOB_RING;
  const dx = tx - r.from.x;
  const dy = ty - r.from.y;
  const l = Math.hypot(dx, dy);
  const run = Math.max(0, Math.min(l, (t - r.delay) * MOB_SPEED));
  const ux = l > 1e-6 ? dx / l : 0;
  const uy = l > 1e-6 ? dy / l : 0;
  const going = t > r.delay && run < l;
  out.pos = { x: r.from.x + ux * run, y: r.from.y + uy * run };
  out.vel = going ? { x: ux * MOB_SPEED, y: uy * MOB_SPEED } : { x: 0, y: 0 };
  // Running: facing where he runs. There: facing the scorer.
  const fx = going ? ux : scorer.x - out.pos.x;
  const fy = going ? uy : scorer.y - out.pos.y;
  const fl = Math.hypot(fx, fy) || 1;
  out.facing = { x: fx / fl, y: fy / fl };
  out.sprinting = going;
  return out;
}
