// What a human's input means to the sim: turn one tick of HumanInput into an
// Intent for the player they steer (humanIntent), and decide which player that
// is (updateControl). Pure functions of state and input, no rng, so a replay or
// a lockstep peer reaches the same match.
//
// Pointer scheme (mouse and touch), the main one:
//   run      toward the pointer. Its distance from the player sets the speed:
//            a walk close in, a jog around 6 m, a full sprint from 12 m out.
//   ball     left click   ground pass that rolls to the pointer
//            left hold    lofted ball that lands at the pointer, longer hold = higher and further
//            right click  shot toward the pointer (hold right for more power)
//   no ball  left click   switch to the teammate under the pointer, else the nearest one that way
//            right click  tackle toward the pointer: standing when it is close, a slide when it is far
// Key scheme: WASD/arrows run, Space pass, F shoot, C loft, Space/tackle, E switch, Shift sprint.
// The client (src/client/input.ts) turns buttons and hold times into the fields of HumanInput.

import { SPRINT_MULT } from './constants.ts';
import { oppGoal } from './field.ts';
import { humanPass, pointerPass } from './kicks.ts';
import type { HumanInput, Intent, MatchPlayer, MatchState } from './types.ts';
import { add, clamp, dist, dot, len, norm, scale, sub, type Vec } from './vec.ts';

// ---------------------------------------------------------------------------
// Pointer distance to speed

/** Inside this many metres of the player the pointer means "stay put". */
export const POINTER_DEAD = 0.4;
/** Speed, as a fraction of normal top speed, at the edge of the dead zone: a slow walk. */
export const POINTER_WALK = 0.2;
/** Pointer distance at which the player has reached a jog (0.9 of top speed). */
export const POINTER_JOG_AT = 6;
/** From this far out the player sprints flat out (SPRINT_MULT times top speed). */
export const POINTER_SPRINT_AT = 12;

/**
 * Speed the pointer asks for, as a multiple of normal top speed: 0 inside the
 * dead zone, then a straight line from a walk (0.2) to a jog (0.9) at 6 m, then
 * on to a full sprint (SPRINT_MULT, 1.18) at 12 m. Above 1 means sprinting.
 */
export function pointerEffort(d: number): number {
  if (d <= POINTER_DEAD) return 0;
  if (d < POINTER_JOG_AT) return POINTER_WALK + 0.7 * ((d - POINTER_DEAD) / (POINTER_JOG_AT - POINTER_DEAD));
  if (d < POINTER_SPRINT_AT) return 0.9 + (SPRINT_MULT - 0.9) * ((d - POINTER_JOG_AT) / (POINTER_SPRINT_AT - POINTER_JOG_AT));
  return SPRINT_MULT;
}

/** The intent's throttle and sprint flag for a pointer `d` metres away. Speed is continuous across the sprint threshold. */
export function pointerThrottle(d: number): { throttle: number; sprint: boolean } {
  const e = pointerEffort(d);
  return e > 1 ? { throttle: e / SPRINT_MULT, sprint: true } : { throttle: e, sprint: false };
}

// ---------------------------------------------------------------------------
// Tackles

/** Pointer closer than this: a standing tackle. Further: a slide. */
export const STAND_TACKLE_R = 2.4;
/** A slide never goes further than this, however far the pointer is. */
export const SLIDE_MAX = 6;

// ---------------------------------------------------------------------------
// Picking a player

/** A click within this many metres of a teammate picks him. Also the pass assist radius. */
export const SELECT_R = 1.5;
/** Half-angle of the cone searched for a teammate "in the direction of the click". */
export const SELECT_CONE_COS = Math.cos((40 * Math.PI) / 180);
/** Ticks a hand-picked player is kept before the auto-switch may take him away again. */
export const SELECT_LOCK = 180;

/**
 * Who a click at `point` picks for `team`, given the player now steered:
 *  1. an outfield teammate within SELECT_R of the point (the closest one);
 *  2. else the nearest outfield teammate inside a 40 degree cone around the
 *     direction from the steered player to the point;
 *  3. else -1 (stay as you are).
 * Picking the steered player himself returns his own index.
 */
export function pickTeammate(s: MatchState, team: 0 | 1, point: Vec): number {
  const cur = s.players[s.controlled[team]];
  let under = -1;
  let underD = SELECT_R;
  for (const m of s.players) {
    if (m.team !== team || m.role === 'GK') continue;
    const d = dist(m.pos, point);
    if (d < underD) {
      under = m.i;
      underD = d;
    }
  }
  if (under >= 0) return under;
  const way = norm(sub(point, cur.pos));
  if (way.x === 0 && way.y === 0) return -1;
  let best = -1;
  let bestD = Infinity;
  for (const m of s.players) {
    if (m.team !== team || m.role === 'GK' || m.i === cur.i) continue;
    const to = sub(m.pos, cur.pos);
    const d = len(to);
    if (d < 0.5 || dot(scale(to, 1 / d), way) < SELECT_CONE_COS) continue;
    if (d < bestD) {
      best = m.i;
      bestD = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Intent

export function humanIntent(s: MatchState, p: MatchPlayer, input: HumanInput): Intent {
  let move: Vec = { x: 0, y: 0 };
  let throttle = 0;
  let sprint = false;
  const pointer = input.cursor !== undefined;
  if (input.cursor) {
    const d = sub(input.cursor, p.pos);
    move = norm(d);
    ({ throttle, sprint } = pointerThrottle(len(d)));
  } else if (input.dir && (input.dir.x !== 0 || input.dir.y !== 0)) {
    move = norm(input.dir);
    throttle = 1;
    sprint = !!input.sprint;
  }
  const hasBall = s.ball.owner === p.i;
  const heading = add(p.pos, scale(throttle > 0 ? move : p.facing, 14));

  if (hasBall) {
    if (input.shoot !== undefined) {
      const goal = oppGoal(p.team);
      const target = input.cursor ?? { x: goal.x, y: goal.y + (input.dir?.y ?? 0) * 2.4 };
      return { move, throttle, sprint, action: { kind: 'shoot', target, power: clamp(input.shoot, 0, 1) } };
    }
    if (input.loft !== undefined) {
      // With keys there is no point to aim at: send it as far as the hold allows, the way you are heading.
      const target = input.cursor ?? add(s.ball.pos, scale(norm(sub(heading, p.pos)), 40));
      return { move, throttle, sprint, action: { kind: 'loft', target, power: clamp(input.loft, 0, 1) } };
    }
    if (input.pass) {
      if (pointer) {
        const r = pointerPass(s, p, input.cursor!);
        return { move, throttle, sprint, action: { kind: 'pass', target: r.target, receiver: r.receiver, speed: r.speed } };
      }
      const r = humanPass(s, p, heading);
      return { move, throttle, sprint, action: { kind: 'pass', target: r.target, receiver: r.receiver } };
    }
  } else if (input.tackle) {
    const target = input.cursor ?? s.ball.pos;
    const to = sub(target, p.pos);
    const d = len(to);
    if (pointer && d > STAND_TACKLE_R) {
      const slideTo = add(p.pos, scale(norm(to), Math.min(d, SLIDE_MAX)));
      return { move, throttle, sprint, action: { kind: 'tackle', target: slideTo, slide: true } };
    }
    return { move, throttle, sprint, action: { kind: 'tackle', target } };
  }
  return { move, throttle, sprint };
}

// ---------------------------------------------------------------------------
// Who the human steers

export function updateControl(s: MatchState, team: 0 | 1, input: HumanInput): void {
  if (!s.humans[team]) return;
  const ball = s.ball;
  const outfield = s.players.filter((p) => p.team === team && p.role !== 'GK');
  const owner = ball.owner >= 0 ? s.players[ball.owner] : null;

  // Whoever has the ball, or is about to get it, is who you steer.
  if (owner && owner.team === team) {
    if (owner.role !== 'GK') s.controlled[team] = owner.i;
    return;
  }
  if (ball.receiver >= 0 && s.players[ball.receiver].team === team && s.players[ball.receiver].role !== 'GK') {
    s.controlled[team] = ball.receiver;
    return;
  }
  if (input.select && input.cursor) {
    const pick = pickTeammate(s, team, input.cursor);
    if (pick >= 0) {
      s.controlled[team] = pick;
      s.switchTimer[team] = SELECT_LOCK;
    }
    return;
  }
  const spot = add(ball.pos, scale(ball.vel, 0.3));
  const byDist = [...outfield].sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot));
  if (input.switchPlayer) {
    const pick = byDist[0].i === s.controlled[team] ? byDist[1] : byDist[0];
    s.controlled[team] = pick.i;
    s.switchTimer[team] = 30;
    return;
  }
  if (--s.switchTimer[team] > 0) return;
  s.switchTimer[team] = 12;
  const cur = s.players[s.controlled[team]];
  if (dist(cur.pos, spot) - dist(byDist[0].pos, spot) > 5) s.controlled[team] = byDist[0].i;
}
