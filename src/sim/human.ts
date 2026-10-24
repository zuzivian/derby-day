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
//   keeper   with the ball your keeper is yours too: left click rolls or throws it out, left hold
//            throws or kicks it high, right click punts it long. He may hold it six seconds (Law 12),
//            then the CPU plays it for you.
// A pass on its way to your player: he moves to meet it, and a click (left: pass, right: shot) is
// played first time the moment he has it. After control passes to a new player automatically, he
// holds still with the ball (or plays like the CPU without it) until you move the pointer, so he
// does not run back to where the pointer was left (MatchState.ctlHold).
// Key scheme: WASD/arrows run, Space pass, F shoot, C loft, Space/tackle, E switch, Shift sprint.
// The client (src/client/input.ts) turns buttons and hold times into the fields of HumanInput.

import { aiIntent } from './ai.ts';
import { BOX_DEPTH, BOX_W, PITCH_H, SPRINT_MULT } from './constants.ts';
import { attackDir, oppGoal, ownGoal } from './field.ts';
import { humanPass, pointerPass } from './kicks.ts';
import type { HumanInput, Intent, MatchPlayer, MatchState } from './types.ts';
import { add, clamp, dist, dot, len, norm, scale, sub, type Vec } from './vec.ts';

// ---------------------------------------------------------------------------
// Pointer distance to speed

/**
 * Inside this many metres of the player the pointer means "stay put" (research: a dead zone of
 * about 0.5-1 m; feedback/research-mouse-and-pace.md section 2).
 */
export const POINTER_DEAD = 0.6;
/** Speed, as a fraction of normal top speed, at the edge of the dead zone: a slow walk. */
export const POINTER_WALK = 0.2;
/** Pointer distance at which the player jogs (POINTER_JOG of top speed, about 3.7 m/s). */
export const POINTER_JOG_AT = 4;
export const POINTER_JOG = 0.55;
/** Pointer distance at which the player runs at normal top speed. */
export const POINTER_RUN_AT = 8;
/** From this far out the player sprints flat out (SPRINT_MULT times top speed). */
export const POINTER_SPRINT_AT = 11;

/**
 * Speed the pointer asks for, as a multiple of normal top speed: 0 inside the dead zone,
 * then straight lines from a walk (0.2) to a jog (0.55) at 4 m, a run (1) at 8 m and a full
 * sprint (SPRINT_MULT, 1.18) from 11 m. Above 1 means sprinting. Sprint to jog is about
 * 2.1:1 (research: about 2.5:1, ramping from jog to sprint over 3-12 m of pointer distance).
 */
export function pointerEffort(d: number): number {
  if (d <= POINTER_DEAD) return 0;
  if (d < POINTER_JOG_AT) return POINTER_WALK + (POINTER_JOG - POINTER_WALK) * ((d - POINTER_DEAD) / (POINTER_JOG_AT - POINTER_DEAD));
  if (d < POINTER_RUN_AT) return POINTER_JOG + (1 - POINTER_JOG) * ((d - POINTER_JOG_AT) / (POINTER_RUN_AT - POINTER_JOG_AT));
  if (d < POINTER_SPRINT_AT) return 1 + (SPRINT_MULT - 1) * ((d - POINTER_RUN_AT) / (POINTER_SPRINT_AT - POINTER_RUN_AT));
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

/** A first-time shot struck off a right click made before the ball arrived. */
export const FIRST_TIME_SHOT = 0.75;
/** A click queued for a first-time kick lapses this many ticks after it was made, if the ball has not come. */
const QUEUE_TICKS = 90;

/** Is a pass on its way to this player (the ball loose, him the receiver)? */
export const passIncoming = (s: MatchState, p: MatchPlayer): boolean => s.ball.owner < 0 && s.ball.receiver === p.i;

/** Keeper with the ball in his hands: he may move about his own area with it, not out of it. */
function keepInBox(p: MatchPlayer, move: Vec, throttle: number): { move: Vec; throttle: number } {
  const g = ownGoal(p.team);
  const ahead = add(p.pos, scale(move, 0.6));
  const depth = (ahead.x - g.x) * attackDir(p.team);
  const inside = depth > 0.3 && depth < BOX_DEPTH - 1 && Math.abs(ahead.y - PITCH_H / 2) < BOX_W / 2 - 1;
  return inside ? { move, throttle: Math.min(throttle, 0.5) } : { move, throttle: 0 };
}

/**
 * Step up to meet a pass on its way: to the line of the ball, a couple of metres toward it,
 * at a jog. Taking it earlier is what beats the defender coming round the back.
 */
export function meetBall(s: MatchState, p: MatchPlayer): Intent {
  const b = s.ball;
  const v = len(b.vel);
  if (v < 0.5) {
    const to = sub(b.pos, p.pos);
    return { move: norm(to), throttle: clamp(len(to) / 4, 0, 0.8) };
  }
  const dir = scale(b.vel, 1 / v);
  const along = dot(sub(p.pos, b.pos), dir);
  if (along < 0.5) {
    const to = sub(b.pos, p.pos);
    return { move: norm(to), throttle: 1 };
  }
  const onLine = add(b.pos, scale(dir, along));
  const target = sub(onLine, scale(dir, Math.min(2, along * 0.25)));
  const to = sub(target, p.pos);
  const d = len(to);
  return d < 0.15 ? { move: { x: 0, y: 0 }, throttle: 0 } : { move: scale(to, 1 / d), throttle: clamp(d / 2.5, 0.25, 0.75) };
}

export function humanIntent(s: MatchState, p: MatchPlayer, input: HumanInput): Intent {
  let move: Vec = { x: 0, y: 0 };
  let throttle = 0;
  let sprint = false;
  const pointer = input.cursor !== undefined;
  const aim = input.aim ?? input.cursor;
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
  const team = p.team;
  const held = !!s.ctlHold?.[team] && pointer;

  // A pass is on its way to him: he goes to meet it, and a click now is played first time.
  if (passIncoming(s, p)) {
    if (input.select || input.pass || input.tackle) {
      const target = aim ?? heading;
      const kind = input.tackle && pointer ? 'shoot' : 'pass';
      if (!s.queued) s.queued = [null, null];
      s.queued[team] = { kind, target: { ...target }, player: p.i, until: s.tick + QUEUE_TICKS };
    }
    return meetBall(s, p);
  }

  if (hasBall) {
    if (held) {
      move = { x: 0, y: 0 };
      throttle = 0;
      sprint = false;
    }
    if (s.ball.inHands && p.role === 'GK') ({ move, throttle } = keepInBox(p, move, throttle));
    const q = s.queued?.[team];
    if (q && q.player === p.i && !s.ball.inHands) {
      s.queued![team] = null;
      if (q.kind === 'shoot') return { move, throttle, sprint, action: { kind: 'shoot', target: q.target, power: FIRST_TIME_SHOT } };
      const r = pointerPass(s, p, q.target);
      return { move, throttle, sprint, action: { kind: 'pass', target: r.target, receiver: r.receiver, speed: r.speed } };
    }
    const keeper = p.role === 'GK';
    if (input.shoot !== undefined) {
      if (keeper) {
        const target = aim ?? add(s.ball.pos, scale(norm(sub(heading, p.pos)), 60));
        return { move, throttle, sprint, action: { kind: 'punt', target, power: clamp(input.shoot, 0, 1) } };
      }
      const goal = oppGoal(p.team);
      const target = aim ?? { x: goal.x, y: goal.y + (input.dir?.y ?? 0) * 2.4 };
      return { move, throttle, sprint, action: { kind: 'shoot', target, power: clamp(input.shoot, 0, 1) } };
    }
    if (input.loft !== undefined) {
      // With keys there is no point to aim at: send it as far as the hold allows, the way you are heading.
      const target = aim ?? add(s.ball.pos, scale(norm(sub(heading, p.pos)), 40));
      return { move, throttle, sprint, action: { kind: 'loft', target, power: clamp(input.loft, 0, 1) } };
    }
    if (input.pass) {
      if (pointer) {
        const r = pointerPass(s, p, aim!);
        return { move, throttle, sprint, action: { kind: 'pass', target: r.target, receiver: r.receiver, speed: r.speed } };
      }
      const r = humanPass(s, p, heading);
      return { move, throttle, sprint, action: { kind: 'pass', target: r.target, receiver: r.receiver } };
    }
    return { move, throttle, sprint };
  }
  if (held) {
    // Until the pointer moves, he plays like the CPU would (but takes no action of his own).
    const it = aiIntent(s, p);
    move = it.move;
    throttle = it.throttle;
    sprint = !!it.sprint;
  }
  if (input.tackle) {
    const target = aim ?? s.ball.pos;
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

/** May the human steer this keeper now? Only while he has the ball, or it is on its way to him, or he takes a restart. */
export function keeperControllable(s: MatchState, p: MatchPlayer): boolean {
  return s.ball.owner === p.i || passIncoming(s, p) || (!!s.restart && s.restart.taker === p.i && s.restart.stage !== 'whistle');
}

/** Hand the human `team` a new player. `auto`: not something they clicked, so hold him until the pointer moves. */
function give(s: MatchState, team: 0 | 1, i: number, auto: boolean): void {
  if (s.controlled[team] === i) return;
  s.controlled[team] = i;
  if (!s.ctlHold) s.ctlHold = [false, false];
  s.ctlHold[team] = auto;
  if (s.queued?.[team] && s.queued[team]!.player !== i) s.queued[team] = null;
}

export function updateControl(s: MatchState, team: 0 | 1, input: HumanInput): void {
  if (!s.humans[team]) return;
  // Moving the pointer (or pressing a direction key) ends the hold after an automatic switch.
  if (s.ctlHold?.[team] && (input.moved || (input.dir && (input.dir.x !== 0 || input.dir.y !== 0)) || !input.cursor)) s.ctlHold[team] = false;
  const q = s.queued?.[team];
  if (q && s.tick > q.until && s.ball.owner !== q.player) s.queued![team] = null;
  const ball = s.ball;
  const outfield = s.players.filter((p) => p.team === team && p.role !== 'GK' && !p.sentOff);
  const owner = ball.owner >= 0 ? s.players[ball.owner] : null;

  // Whoever has the ball, or is about to get it, is who you steer: the keeper too.
  if (owner && owner.team === team) {
    give(s, team, owner.i, true);
    return;
  }
  if (ball.receiver >= 0 && s.players[ball.receiver].team === team) {
    give(s, team, ball.receiver, true);
    return;
  }
  if (input.select && input.cursor) {
    const pick = pickTeammate(s, team, input.aim ?? input.cursor);
    if (pick >= 0) {
      give(s, team, pick, false);
      s.switchTimer[team] = SELECT_LOCK;
    }
    return;
  }
  if (!outfield.length) return;
  const spot = add(ball.pos, scale(ball.vel, 0.3));
  const byDist = [...outfield].sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot));
  if (input.switchPlayer) {
    const pick = byDist[0].i === s.controlled[team] ? byDist[1] ?? byDist[0] : byDist[0];
    give(s, team, pick.i, false);
    s.switchTimer[team] = 30;
    return;
  }
  const cur = s.players[s.controlled[team]];
  // The keeper has let it go: straight to whoever is nearest it.
  if (cur && cur.role === 'GK' && !keeperControllable(s, cur)) {
    give(s, team, byDist[0].i, true);
    return;
  }
  if (--s.switchTimer[team] > 0) return;
  s.switchTimer[team] = 12;
  if (!cur || dist(cur.pos, spot) - dist(byDist[0].pos, spot) > 5) give(s, team, byDist[0].i, true);
}
