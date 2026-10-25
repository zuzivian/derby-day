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
import { BOX_DEPTH, BOX_W, GRAVITY, PITCH_H, SLIDE_TRAVEL, SPRINT_MULT, STAND_REACH } from './constants.ts';
import { attackDir, oppGoal, ownGoal } from './field.ts';
import { assistReceiver, humanPass, humanShotLift, passTo, pointerPass } from './kicks.ts';
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

/** Closer than this: a standing tackle. Further: a slide. The same as a standing tackle's reach. */
export const STAND_TACKLE_R = STAND_REACH;
/** A slide never goes further than this, however far the pointer is. */
export const SLIDE_MAX = SLIDE_TRAVEL;
/** A click this close to the man a pass is coming to is "take it", not a first-time pass. */
const TAKE_IT_R = 3;
/** A right click this close to an opponent with the ball (or the ball he has) is a tackle on him. */
const ON_CARRIER = 1.5;

// ---------------------------------------------------------------------------
// Picking a player

/** A click within this many metres of a teammate picks him. Also the pass assist radius. */
export const SELECT_R = 1.5;
/** Half-angle of the cone searched for a teammate "in the direction of the click". */
export const SELECT_CONE_COS = Math.cos((40 * Math.PI) / 180);
/** A click within this many metres of a teammate picks the one nearest it, before any cone search. */
export const PICK_R = 4;
/** Ticks an automatically switched-to player is kept before the auto-switch looks again. */
const AUTO_KEEP = 45;
/** Ticks a hand-picked player is kept before the auto-switch may take him away again. */
export const SELECT_LOCK = 180;

/**
 * Who a click at `point` picks for `team`, given the player now steered:
 *  1. an outfield teammate within PICK_R of the point (the closest one): a click a couple of
 *     metres off a man means him, not whoever happens to lie nearer you in that direction;
 *  2. else the nearest outfield teammate inside a 40 degree cone around the
 *     direction from the steered player to the point;
 *  3. else -1 (stay as you are).
 * Picking the steered player himself returns his own index.
 */
export function pickTeammate(s: MatchState, team: 0 | 1, point: Vec): number {
  const cur = s.players[s.controlled[team]];
  let under = -1;
  let underD = PICK_R;
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

/** Ticks the pointer must really move before a player held after an automatic switch is the human's again (about 0.13 s of moving it). */
export const HOLD_MOVES = 8;

/** A first-time shot struck off a right click made before the ball arrived. */
export const FIRST_TIME_SHOT = 0.75;
/** A click queued for a first-time kick lapses this many ticks after it was made, if the ball has not come. */
const QUEUE_TICKS = 90;

/** Is a pass on its way to this player (the ball loose, him the receiver)? */
export const passIncoming = (s: MatchState, p: MatchPlayer): boolean => s.ball.owner < 0 && s.ball.receiver === p.i;

/** Keeper with the ball in his hands: he may move about his own area with it, not out of it. */
function keepInBox(s: MatchState, p: MatchPlayer, move: Vec, throttle: number): { move: Vec; throttle: number } {
  const g = ownGoal(s, p.team);
  const ahead = add(p.pos, scale(move, 0.6));
  const depth = (ahead.x - g.x) * attackDir(s, p.team);
  const inside = depth > 0.3 && depth < BOX_DEPTH - 1 && Math.abs(ahead.y - PITCH_H / 2) < BOX_W / 2 - 1;
  return inside ? { move, throttle: Math.min(throttle, 0.5) } : { move, throttle: 0 };
}

/**
 * Step up to meet a pass on its way: across to the line of the ball, a step toward it, as
 * fast as he needs to be there before it is. Taking it earlier is what beats the defender
 * coming round the back.
 */
/** A ball in the air drops to chest height here (no drag): where to meet it, not under its flight. */
function dropPoint(s: MatchState): Vec {
  const b = s.ball;
  const z = 1.2;
  const disc = b.vz * b.vz + 2 * GRAVITY * Math.max(0, b.z - z);
  const t = b.z > z || b.vz > 0 ? (b.vz + Math.sqrt(Math.max(0, disc))) / GRAVITY : 0;
  return add(b.pos, scale(b.vel, t));
}

export function meetBall(s: MatchState, p: MatchPlayer): Intent {
  const b = s.ball;
  if (b.z > 1.5 || b.vz > 0) {
    // Lofted: get to where it comes down and wait for it there.
    const to = sub(dropPoint(s), p.pos);
    const d = len(to);
    if (d < 0.3) return { move: { x: 0, y: 0 }, throttle: 0 };
    const t = Math.max(0.2, (b.vz + Math.sqrt(b.vz * b.vz + 2 * GRAVITY * b.z)) / GRAVITY - 0.2);
    const effort = clamp(d / t / 6.5, 0.3, SPRINT_MULT);
    return effort > 1 ? { move: scale(to, 1 / d), throttle: effort / SPRINT_MULT, sprint: true } : { move: scale(to, 1 / d), throttle: effort };
  }
  const v = len(b.vel);
  if (v < 0.5) {
    const to = sub(b.pos, p.pos);
    return { move: norm(to), throttle: clamp(len(to) / 4, 0, 0.8) };
  }
  const dir = scale(b.vel, 1 / v);
  const along = dot(sub(p.pos, b.pos), dir);
  if (along < 0.5) {
    // It is past him (or he is chasing it down): run after it, flat out if it is getting away.
    const to = sub(b.pos, p.pos);
    return { move: norm(to), throttle: 1, sprint: v > 4 };
  }
  const onLine = add(b.pos, scale(dir, along));
  const target = sub(onLine, scale(dir, Math.min(1, along * 0.15)));
  const to = sub(target, p.pos);
  const d = len(to);
  if (d < 0.15) return { move: { x: 0, y: 0 }, throttle: 0 };
  // Speed he needs to get there with a little time to spare, as a share of a normal run (about 7 m/s).
  const need = d / Math.max(0.15, along / v - 0.1);
  const effort = clamp(need / 6.5, 0.3, SPRINT_MULT);
  return effort > 1 ? { move: scale(to, 1 / d), throttle: effort / SPRINT_MULT, sprint: true } : { move: scale(to, 1 / d), throttle: effort };
}

/** The ball is loose with no receiver, and he is the nearest outfielder on his side to where it is going. */
function looseForHim(s: MatchState, p: MatchPlayer): boolean {
  const b = s.ball;
  if (b.owner >= 0 || b.receiver >= 0 || s.phase !== 'play') return false;
  const at = b.z > 0 || b.vz > 0 ? dropPoint(s) : b.pos;
  const mine = dist(p.pos, at);
  return !s.players.some((m) => m.team === p.team && m.i !== p.i && m.role !== 'GK' && !m.sentOff && m.stun === 0 && dist(m.pos, at) < mine);
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
    // A click on himself (the second half of a double click, say) means take it, not play it on.
    const onHimself = !!aim && !input.tackle && dist(aim, p.pos) < TAKE_IT_R;
    if ((input.select || input.pass || input.tackle) && !onHimself) {
      const target = aim ?? heading;
      const kind = input.tackle && pointer ? 'shoot' : 'pass';
      // Who the click picks is settled now, from where he will receive it.
      const receiver = kind === 'pass' && pointer ? assistReceiver(s, p, p.pos, target) : -1;
      if (!s.queued) s.queued = [null, null];
      s.queued[team] = { kind, target: { ...target }, player: p.i, receiver, until: s.tick + QUEUE_TICKS };
    }
    return meetBall(s, p);
  }

  if (hasBall) {
    if (held) {
      move = { x: 0, y: 0 };
      throttle = 0;
      sprint = false;
    }
    if (s.ball.inHands && p.role === 'GK') ({ move, throttle } = keepInBox(s, p, move, throttle));
    const q = s.queued?.[team];
    if (q && q.player === p.i && !s.ball.inHands) {
      s.queued![team] = null;
      if (q.kind === 'shoot') return { move, throttle, sprint, action: { kind: 'shoot', target: q.target, power: FIRST_TIME_SHOT, lift: humanShotLift(s.ball.pos, q.target, oppGoal(s, p.team).x, FIRST_TIME_SHOT, p.attrs.shooting) } };
      const mate = q.receiver >= 0 ? s.players[q.receiver] : null;
      const r = mate && !mate.sentOff ? passTo(s, mate) : pointerPass(s, p, q.target);
      return { move, throttle, sprint, action: { kind: 'pass', target: r.target, receiver: r.receiver, speed: r.speed } };
    }
    const keeper = p.role === 'GK';
    if (input.shoot !== undefined) {
      if (keeper) {
        const target = aim ?? add(s.ball.pos, scale(norm(sub(heading, p.pos)), 60));
        return { move, throttle, sprint, action: { kind: 'punt', target, power: clamp(input.shoot, 0, 1) } };
      }
      const goal = oppGoal(s, p.team);
      const target = aim ?? { x: goal.x, y: goal.y + (input.dir?.y ?? 0) * 2.4 };
      // The harder he hits it, the higher it rises (a click stays low).
      const power = clamp(input.shoot, 0, 1);
      const curl = input.curl ? clamp(input.curl, -1, 1) : 0;
      return { move, throttle, sprint, action: { kind: 'shoot', target, power, lift: humanShotLift(s.ball.pos, target, goal.x, power, p.attrs.shooting), ...(curl ? { curl } : {}) } };
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
  if (held && looseForHim(s, p)) {
    // A loose ball nobody is meant for, and he is our nearest: he goes for it (the CPU would
    // leave it to the man the human steers).
    const it = meetBall(s, p);
    move = it.move;
    throttle = it.throttle;
    sprint = !!it.sprint;
  } else if (held) {
    // Until the pointer moves, he plays like the CPU would (but takes no action of his own).
    const it = aiIntent(s, p);
    move = it.move;
    throttle = it.throttle;
    sprint = !!it.sprint;
  }
  // Not straight after his own kick: a second right click just after a shot is not a slide.
  if (input.tackle && p.kickCd === 0) {
    let target = aim ?? s.ball.pos;
    // A click on (or near) the man with the ball goes in on him: stand or slide by how far
    // he is, so the choice always matches what can reach.
    const carrier = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
    const onHim = pointer && !!carrier && carrier.team !== team && Math.min(dist(target, carrier.pos), dist(target, s.ball.pos)) < ON_CARRIER;
    if (onHim) target = s.ball.pos;
    const to = sub(target, p.pos);
    const d = onHim ? dist(carrier!.pos, p.pos) : len(to);
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

/** Law 12: ticks a keeper may hold the ball in his hands before the CPU plays it for a human (six seconds). */
export const KEEPER_HOLD_TICKS = 360;

/** Seconds left before the human's keeper must let the ball go (a whole number, for a countdown), or null when he isn't holding it. */
export function keeperHoldLeft(s: MatchState, team: 0 | 1): number | null {
  const b = s.ball;
  if (!s.humans[team] || b.owner < 0 || !b.inHands || s.phase !== 'play') return null;
  const gk = s.players[b.owner];
  if (gk.team !== team || gk.role !== 'GK') return null;
  return Math.max(0, Math.ceil((KEEPER_HOLD_TICKS - (b.handTicks ?? 0)) / 60));
}

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
  // Really moving the pointer (HOLD_MOVES ticks of it, so a resting hand's nudge doesn't
  // count), or pressing a direction key, ends the hold after an automatic switch.
  if (s.ctlHold?.[team]) {
    if (!s.ctlHoldMoves) s.ctlHoldMoves = [0, 0];
    if (input.moved) s.ctlHoldMoves[team]++;
    if (s.ctlHoldMoves[team] >= HOLD_MOVES || (input.dir && (input.dir.x !== 0 || input.dir.y !== 0)) || !input.cursor) s.ctlHold[team] = false;
  }
  if (s.ctlHoldMoves && !s.ctlHold?.[team]) s.ctlHoldMoves[team] = 0;
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
  // Never off a man the ball is coming to and nearly at: he is about to play it.
  if (cur && dist(cur.pos, ball.pos) < 3 && dot(sub(cur.pos, ball.pos), ball.vel) > 0) return;
  if (!cur || dist(cur.pos, spot) - dist(byDist[0].pos, spot) > 5) {
    give(s, team, byDist[0].i, true);
    // Then keep him a moment: not straight back to the last man as the ball runs on.
    s.switchTimer[team] = AUTO_KEEP;
  }
}
