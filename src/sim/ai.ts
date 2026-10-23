// CPU behaviour for every player the human isn't steering. It reads the match
// state and returns an Intent; it never mutates anything except per-player
// timers and the shared RNG, so it runs identically on client and server.

import { BOX_DEPTH, FORMATION, GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W } from './constants.ts';
import {
  attackDir,
  clampToPitch,
  fromTeam,
  goalkeeper,
  nearestOpponentDist,
  oppGoal,
  ownGoal,
  teamX,
} from './field.ts';
import { chance, next, range } from './rng.ts';
import type { Intent, MatchPlayer, MatchState } from './types.ts';
import { add, clamp, dist, distToSegment, dot, len, norm, scale, sub, type Vec } from './vec.ts';

const IDLE: Intent = { move: { x: 0, y: 0 }, throttle: 0 };

function seek(p: MatchPlayer, target: Vec, arrive = 2.5, cap = 1): Intent {
  const d = sub(target, p.pos);
  const l = len(d);
  if (l < 0.25) return IDLE;
  return { move: norm(d), throttle: Math.min(cap, l / arrive) };
}

function decisionInterval(s: MatchState, p: MatchPlayer): number {
  const skill = s.teams[p.team].aiSkill;
  return Math.round(15 - 8 * skill + next(s.rng) * 6);
}

export interface PassOption {
  receiver: MatchPlayer;
  target: Vec;
  score: number;
}

/** Lead a pass so it arrives where the receiver will be. */
export function leadTarget(from: Vec, m: MatchPlayer, passing: number): Vec {
  const d = dist(from, m.pos);
  const speed = passSpeed(d, passing);
  const t = d / (speed * 0.75);
  return clampToPitch(add(m.pos, scale(m.vel, Math.min(t, 1.2))), 1);
}

export function passSpeed(d: number, passing: number): number {
  return clamp(7 + d * 0.75, 8, 21) * (0.9 + 0.2 * passing);
}

export function bestPassOption(s: MatchState, p: MatchPlayer): PassOption | null {
  let best: PassOption | null = null;
  const px = teamX(p.team, p.pos.x);
  for (const m of s.players) {
    if (m.team !== p.team || m.i === p.i || m.stun > 0) continue;
    const d = dist(p.pos, m.pos);
    if (d < 4 || d > 32) continue;
    const target = leadTarget(p.pos, m, p.attrs.passing);
    let lane = Infinity;
    let marker = Infinity;
    for (const o of s.players) {
      if (o.team === p.team) continue;
      lane = Math.min(lane, distToSegment(o.pos, s.ball.pos, target));
      marker = Math.min(marker, dist(o.pos, target));
    }
    const progress = (teamX(p.team, target.x) - px) * PITCH_W;
    const score =
      progress * 0.07 +
      Math.min(lane, 4) * 0.45 +
      Math.min(marker, 5) * 0.25 -
      d * 0.02 -
      (lane < 1.2 ? 2 : 0) -
      (m.role === 'GK' ? 2.5 : 0);
    if (!best || score > best.score) best = { receiver: m, target, score };
  }
  return best;
}

/**
 * For a human pass: pick the teammate closest to the aim direction, or pass
 * into space at the aim point if nobody is in the cone.
 */
export function resolvePassTarget(s: MatchState, p: MatchPlayer, aim: Vec): { target: Vec; receiver: number } {
  let toAim = sub(aim, p.pos);
  if (len(toAim) < 1) toAim = p.facing;
  const dirAim = norm(toAim);
  let best: MatchPlayer | null = null;
  let bestScore = -Infinity;
  for (const m of s.players) {
    if (m.team !== p.team || m.i === p.i) continue;
    const to = sub(m.pos, p.pos);
    const d = len(to);
    if (d < 2) continue;
    const cos = dot(norm(to), dirAim);
    if (cos < 0.79) continue; // about 38 degrees either side
    const score = cos * 2 - dist(m.pos, aim) * 0.05 - d * 0.01 - (m.role === 'GK' ? 0.6 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  if (best) return { target: leadTarget(p.pos, best, p.attrs.passing), receiver: best.i };
  const far = len(toAim) < 1 ? add(p.pos, scale(dirAim, 12)) : aim;
  return { target: clampToPitch(far, 0.5), receiver: -1 };
}

function shotTarget(s: MatchState, p: MatchPlayer): Vec {
  const goal = oppGoal(p.team);
  const gk = goalkeeper(s, p.team === 0 ? 1 : 0);
  const farSide = gk.pos.y < PITCH_H / 2 ? GOAL_BOTTOM - 0.7 : GOAL_TOP + 0.7;
  return { x: goal.x, y: farSide + range(s.rng, -0.6, 0.6) };
}

function ownerIntent(s: MatchState, p: MatchPlayer): Intent {
  const goal = oppGoal(p.team);
  const dGoal = dist(p.pos, goal);
  const pressure = nearestOpponentDist(s, p);

  if (p.aiTimer <= 0) {
    p.aiTimer = decisionInterval(s, p);
    const shotRange = 12 + 8 * p.attrs.shooting;
    const angleOk = Math.abs(p.pos.y - PITCH_H / 2) < dGoal * 0.95;
    if (dGoal < shotRange && angleOk) {
      const pShoot = dGoal < 9 ? 0.85 : 0.3 + 0.35 * p.attrs.shooting;
      if (chance(s.rng, pShoot)) {
        return { move: norm(sub(goal, p.pos)), throttle: 1, action: { kind: 'shoot', target: shotTarget(s, p), power: range(s.rng, 0.6, 0.95) } };
      }
    }
    const opt = bestPassOption(s, p);
    const deep = teamX(p.team, p.pos.x) < 0.25;
    if (opt) {
      const underPressure = pressure < 2.8 && opt.score > -0.5;
      const progressive = opt.score > 1.3 && chance(s.rng, 0.3 + 0.2 * p.attrs.passing);
      if (underPressure || progressive || (deep && pressure < 4)) {
        return { move: p.facing, throttle: 0.6, action: { kind: 'pass', target: opt.target, receiver: opt.receiver.i } };
      }
    }
    if (deep && pressure < 1.8) {
      const clear = { x: goal.x - attackDir(p.team) * 20, y: range(s.rng, 6, PITCH_H - 6) };
      return { move: p.facing, throttle: 0.6, action: { kind: 'shoot', target: clear, power: 0.8 } };
    }
  }

  // Dribble toward goal, steering around opponents ahead.
  let desired = norm(sub(goal, p.pos));
  for (const o of s.players) {
    if (o.team === p.team) continue;
    const to = sub(o.pos, p.pos);
    const d = len(to);
    if (d > 5 || dot(to, desired) <= 0) continue;
    const side = to.x * desired.y - to.y * desired.x > 0 ? 1 : -1;
    const perp = { x: -desired.y * side, y: desired.x * side };
    desired = add(desired, scale(perp, ((5 - d) / 5) * 1.3));
  }
  // Stay off the boards.
  if (p.pos.y < 3) desired.y += 0.6;
  if (p.pos.y > PITCH_H - 3) desired.y -= 0.6;
  return { move: norm(desired), throttle: 1 };
}

function gkIntent(s: MatchState, p: MatchPlayer): Intent {
  const ball = s.ball;
  const own = ownGoal(p.team);
  const dir = attackDir(p.team);

  if (ball.owner === p.i) {
    p.holdTicks++;
    if (p.holdTicks > 40) {
      const opt = bestPassOption(s, p);
      if (opt && opt.score > -1.5) return { move: IDLE.move, throttle: 0, action: { kind: 'pass', target: opt.target, receiver: opt.receiver.i } };
      return { move: IDLE.move, throttle: 0, action: { kind: 'shoot', target: { x: PITCH_W / 2, y: range(s.rng, 8, PITCH_H - 8) }, power: 0.75 } };
    }
    return IDLE;
  }

  const ballDist = dist(ball.pos, p.pos);
  const ballInBox = teamX(p.team, ball.pos.x) * PITCH_W < BOX_DEPTH + 1 && Math.abs(ball.pos.y - PITCH_H / 2) < 9;
  const speed = len(ball.vel);

  // Rush a loose ball in the box that nobody closer can claim.
  if (ball.owner < 0 && ballInBox && speed < 9) {
    let closest = true;
    for (const o of s.players) if (o.i !== p.i && dist(o.pos, ball.pos) < ballDist - 0.5) closest = false;
    if (closest) return seek(p, ball.pos, 1);
  }

  // Shot coming: move to where it crosses the keeper's line.
  const lineX = own.x + dir * 1.2;
  let targetY = PITCH_H / 2 + (ball.pos.y - PITCH_H / 2) * 0.35;
  const towardGoal = ball.vel.x * dir < -4;
  if (ball.owner < 0 && towardGoal) {
    const t = (lineX - ball.pos.x) / ball.vel.x;
    if (t > 0 && t < 1.5) {
      const react = 0.4 + 0.6 * p.attrs.goalkeeping;
      targetY = targetY + (ball.pos.y + ball.vel.y * t - targetY) * react;
    }
  }
  const depth = ball.owner >= 0 && s.players[ball.owner].team !== p.team ? clamp(9 - dist(ball.pos, own) * 0.25, 1.2, 3) : 1.2;
  const target = { x: own.x + dir * depth, y: clamp(targetY, GOAL_TOP - 0.6, GOAL_BOTTOM + 0.6) };
  return seek(p, target, 1.2);
}

function formationTarget(s: MatchState, p: MatchPlayer, inPossession: boolean): Vec {
  const slot = FORMATION[p.slot];
  const bx = teamX(p.team, s.ball.pos.x);
  const by = s.ball.pos.y / PITCH_H;
  let nx = slot.x + (bx - 0.45) * 0.55 + (inPossession ? 0.1 : -0.05);
  if (p.role === 'DEF' && !inPossession) nx = Math.min(nx, bx - 0.04);
  if (p.role === 'FWD' && inPossession) nx = Math.max(nx, Math.min(0.9, bx + 0.08));
  nx = clamp(nx + p.jitter.x, 0.06, 0.92);
  const ny = clamp(slot.y * 0.75 + by * 0.25 + p.jitter.y, 0.06, 0.94);
  return fromTeam(p.team, nx, ny);
}

export function aiIntent(s: MatchState, p: MatchPlayer): Intent {
  if (p.stun > 0) return IDLE;
  p.aiTimer--;
  if (--p.jitterTimer <= 0) {
    p.jitterTimer = 60 + Math.floor(next(s.rng) * 60);
    p.jitter = { x: range(s.rng, -0.05, 0.05), y: range(s.rng, -0.06, 0.06) };
  }
  if (p.role === 'GK') return gkIntent(s, p);

  const ball = s.ball;
  if (ball.owner === p.i) return ownerIntent(s, p);

  const owner = ball.owner >= 0 ? s.players[ball.owner] : null;
  const inPossession = !!owner && owner.team === p.team;
  const human = s.humanTeam === p.team ? s.controlled : -1;

  if (ball.receiver === p.i) return seek(p, add(ball.pos, scale(ball.vel, 0.35)), 1);

  // Who on this team goes for the ball: nearest outfield player, unless the
  // human is already the nearest, in which case the AI only covers.
  const ranked = s.players
    .filter((m) => m.team === p.team && m.role !== 'GK' && m.stun === 0)
    .sort((a, b) => dist(a.pos, ball.pos) - dist(b.pos, ball.pos));
  const chaser = ranked[0]?.i === human ? -1 : ranked[0]?.i;
  const cover = ranked[1]?.i;

  if (!owner) {
    if (p.i === chaser) return seek(p, add(ball.pos, scale(ball.vel, 0.4)), 1);
    return seek(p, formationTarget(s, p, ball.lastTouch >= 0 && s.players[ball.lastTouch].team === p.team), 3, 0.9);
  }

  if (!inPossession) {
    if (p.i === chaser) {
      const own = ownGoal(p.team);
      const cut = add(add(owner.pos, scale(owner.vel, 0.25)), scale(norm(sub(own, owner.pos)), 0.8));
      const d = dist(p.pos, owner.pos);
      if (d < 1.6 && p.tackleCd === 0 && p.aiTimer <= 0) {
        p.aiTimer = decisionInterval(s, p);
        if (chance(s.rng, 0.45 + 0.35 * p.attrs.defending)) return { move: norm(sub(owner.pos, p.pos)), throttle: 1, action: { kind: 'tackle', target: owner.pos } };
      }
      return seek(p, cut, 1);
    }
    if (p.i === cover) {
      const own = ownGoal(p.team);
      return seek(p, add(owner.pos, scale(norm(sub(own, owner.pos)), 5)), 2);
    }
    return seek(p, formationTarget(s, p, false), 3, 0.9);
  }

  // Team has the ball: take up an attacking slot, but don't crowd the carrier.
  let target = formationTarget(s, p, true);
  const fromOwner = sub(target, owner.pos);
  if (len(fromOwner) < 6) target = add(owner.pos, scale(norm(len(fromOwner) < 0.1 ? { x: 0, y: 1 } : fromOwner), 6));
  return seek(p, clampToPitch(target, 1.2), 3, 0.95);
}
