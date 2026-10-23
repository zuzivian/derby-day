// CPU behaviour for every player the human isn't steering. It reads the match
// state and returns an Intent; it never mutates anything except per-player
// timers and memory and the shared RNG, so it runs identically on client and
// server.
//
// Structure:
//   teamPlan()      per team, every 1-5 ticks: who chases the ball, who marks
//                   whom, where each player can intercept a loose ball.
//   ownerIntent()   the ball carrier: shoot, chip, pass (to feet, through ball,
//                   switch), carry, take a man on, shield, or clear.
//   supportTarget() off-ball attackers: runs in behind, wide channels, short
//                   options, spread out, one defender stays home.
//   defendIntent()  press, mark goal-side, step in to intercept, cover.
//   gkIntent()      angle play, sweeping, shot reaction, distribution.
//
// Difficulty (TeamSetup.aiSkill, 0..1) scales:
//   reaction  how stale the plan is (rebuilt every 1 tick at skill 1, every
//             5 at skill 0) and how far behind the ball the team "sees" it;
//   decisions how often players re-decide and how much noise is added to
//             pass, shot and positioning scores;
//   execution extra drift on passes and shots on top of attribute error;
//   defending how wide the marking zone is, how readily markers step in to
//             intercept, whether anyone sweeps, how far the keeper sweeps.
// scripts/ai-probe.ts measures it with equal squads. Tuning numbers below were
// chosen with that and scripts/balance.ts; change them with both to hand.

import {
  AIR_DRAG,
  BOX_DEPTH,
  FORMATION,
  GOAL_BOTTOM,
  GOAL_TOP,
  GRAVITY,
  KEEPER_REACH_Z,
  PITCH_H,
  PITCH_W,
  REACH_Z,
  SPRINT_MULT,
} from './constants.ts';
import {
  attackDir,
  clampToPitch,
  fromTeam,
  goalkeeper,
  inOwnBox,
  oppGoal,
  ownGoal,
  teamX,
} from './field.ts';
import { chipPlan } from './kicks.ts';
import { chance, gauss, next, range } from './rng.ts';
import type { AiInterception, AiMemory, AiTeamPlan, Intent, MatchPlayer, MatchState } from './types.ts';
import { add, clamp, dot, rotate, scale, sub, type Vec } from './vec.ts';

// Local sqrt-based helpers: Math.hypot is several times slower, and sqrt is
// correctly rounded under IEEE-754, so it is also the safer choice for
// bit-identical results across engines.
const len = (a: Vec): number => Math.sqrt(a.x * a.x + a.y * a.y);
const dist = (a: Vec, b: Vec): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};
function norm(a: Vec): Vec {
  const l = Math.sqrt(a.x * a.x + a.y * a.y);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}
function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-9) return dist(p, a);
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / l2, 0, 1);
  const dx = p.x - (a.x + abx * t);
  const dy = p.y - (a.y + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

const IDLE: Intent = { move: { x: 0, y: 0 }, throttle: 0 };
const MID_Y = PITCH_H / 2;
const GOAL_HALF = (GOAL_BOTTOM - GOAL_TOP) / 2;
/** Shoot when the estimated chance of scoring beats this. */
const SHOOT_XG = 0.035;

function seek(p: MatchPlayer, target: Vec, arrive = 2.5, cap = 1): Intent {
  const d = sub(target, p.pos);
  const l = len(d);
  if (l < 0.25) return IDLE;
  return { move: norm(d), throttle: Math.min(cap, l / arrive) };
}

const skillOf = (s: MatchState, team: 0 | 1): number => clamp(s.teams[team].aiSkill, 0, 1);

/** Seconds of staleness in where a team "sees" the ball: 0.15 s at skill 0, 0.03 s at skill 1. */
const reactionLag = (skill: number): number => 0.03 + 0.12 * (1 - skill);

function decisionInterval(s: MatchState, p: MatchPlayer): number {
  const skill = skillOf(s, p.team);
  return Math.round(17 - 11 * skill + next(s.rng) * (4 + 6 * (1 - skill)));
}

/** Top running speed, mirroring movePlayer in match.ts closely enough for planning. */
const runSpeed = (p: MatchPlayer): number => (5 + 3.4 * p.attrs.pace) * (0.82 + 0.18 * p.energy);

/**
 * Whether to sprint. Urgent moments (a contested loose ball, a run in behind,
 * closing down near our goal, open grass ahead) are worth the legs if there is
 * energy left. Careless low-skill sides also sprint when it doesn't matter and
 * end up winded.
 */
function sprintOk(s: MatchState, p: MatchPlayer, urgent: boolean): boolean {
  if (p.winded) return false;
  if (urgent) return p.energy > 0.58;
  return skillOf(s, p.team) < 0.4 && p.energy > 0.72;
}

function memOf(s: MatchState, p: MatchPlayer): AiMemory {
  let m = p.ai;
  if (!m) {
    m = { lastTick: s.tick, target: null, retarget: 0, attacking: false, mode: 'none', modeTicks: 0, modeTarget: null };
    p.ai = m;
  }
  if (s.tick - m.lastTick > 2) {
    // Kickoff or a pause: drop anything stale.
    m.target = null;
    m.retarget = 0;
    m.mode = 'none';
  }
  m.lastTick = s.tick;
  return m;
}

// ---------------------------------------------------------------------------
// Ball prediction. Mirrors the friction model in match.ts updateBall:
// dv/dt = -(1.6 + 0.35 v), so v(t) = (v0 + a/b) e^(-bt) - a/b.

const FA = 1.6;
const FB = 0.35;

function ballTravel(v0: number, t: number): number {
  if (v0 <= 0) return 0;
  const c = v0 + FA / FB;
  const tStop = Math.log(c / (FA / FB)) / FB;
  const tt = Math.min(t, tStop);
  return (c * (1 - Math.exp(-FB * tt))) / FB - (FA / FB) * tt;
}

const TRAJ_DT = 0.08;
const TRAJ_STEPS = 38; // about 3 s

interface Trajectory {
  pts: Vec[];
  /** Height at each step; 0 once the ball is back on the floor. */
  z: number[];
  v0: number;
}

/**
 * Predicted ball positions every TRAJ_DT seconds, folded back off the boards.
 * A lofted ball flies with light drag until it lands (match.ts: gravity,
 * AIR_DRAG, then a damped bounce), then rolls with floor friction.
 */
function trajectory(pos: Vec, vel: Vec, z0: number, vz0: number): Trajectory {
  const v0 = len(vel);
  const dx = v0 > 1e-6 ? vel.x / v0 : 0;
  const dy = v0 > 1e-6 ? vel.y / v0 : 0;
  const airborne = z0 > 0.01 || vz0 > 0.01;
  const tLand = airborne ? (vz0 + Math.sqrt(vz0 * vz0 + 2 * GRAVITY * Math.max(0, z0))) / GRAVITY : 0;
  const dLand = airborne ? (v0 * (1 - Math.exp(-AIR_DRAG * tLand))) / AIR_DRAG : 0;
  const vLand = airborne ? v0 * Math.exp(-AIR_DRAG * tLand) * 0.82 : v0;
  const pts: Vec[] = new Array(TRAJ_STEPS);
  const zs: number[] = new Array(TRAJ_STEPS);
  for (let k = 0; k < TRAJ_STEPS; k++) {
    const t = k * TRAJ_DT;
    let d: number;
    if (t < tLand) {
      d = (v0 * (1 - Math.exp(-AIR_DRAG * t))) / AIR_DRAG;
      zs[k] = z0 + vz0 * t - 0.5 * GRAVITY * t * t;
    } else {
      d = dLand + ballTravel(vLand, t - tLand);
      zs[k] = 0;
    }
    let x = pos.x + dx * d;
    let y = pos.y + dy * d;
    if (y < 0) y = -y;
    if (y > PITCH_H) y = 2 * PITCH_H - y;
    const mouth = y > GOAL_TOP && y < GOAL_BOTTOM;
    if (x < 0 && !mouth) x = -x;
    if (x > PITCH_W && !mouth) x = 2 * PITCH_W - x;
    pts[k] = { x: clamp(x, 0.3, PITCH_W - 0.3), y: clamp(y, 0.3, PITCH_H - 0.3) };
  }
  return { pts, z: zs, v0 };
}

function interceptOn(s: MatchState, p: MatchPlayer, traj: Trajectory): AiInterception {
  const sp = runSpeed(p) * (p.winded ? 1 : SPRINT_MULT * 0.97);
  const keeper = p.role === 'GK' && inOwnBox(p.team, p.pos);
  const reach = keeper ? 1.2 + 0.5 * p.attrs.goalkeeping : 0.9;
  const maxZ = keeper ? KEEPER_REACH_Z : REACH_Z;
  const blocked = (s.ball.noPickup[p.i] + p.stun) / 60;
  const { pts, z, v0 } = traj;
  for (let k = 0; k < TRAJ_STEPS; ) {
    const t = k * TRAJ_DT;
    if (t < blocked || z[k] > maxZ) {
      k++;
      continue;
    }
    const need = dist(p.pos, pts[k]) - reach;
    if (need <= sp * Math.max(0, t - 0.12)) return { t, pt: pts[k] };
    // The ball can close the gap at most at its current speed, so skip
    // straight to the first step where catching it is possible at all.
    const tMin = (need + v0 * t + 0.12 * sp) / (sp + v0);
    k = Math.max(k + 1, Math.ceil(tMin / TRAJ_DT));
  }
  const last = pts[TRAJ_STEPS - 1];
  return { t: TRAJ_STEPS * TRAJ_DT + dist(p.pos, last) / sp, pt: last };
}

// ---------------------------------------------------------------------------
// Team plan. Rebuilt every tick for a perfect team and every 5 ticks for the
// weakest, which is most of what "reaction time" means here. It lives in the
// match state so a cloned state (replays, rollback) behaves identically.

const planRefresh = (skill: number): number => 1 + Math.round(4 * (1 - skill));

function teamPlan(s: MatchState, team: 0 | 1): AiTeamPlan {
  const plans = (s.aiPlans ??= [null, null]);
  const cur = plans[team];
  if (cur && s.tick >= cur.tick && s.tick - cur.tick < planRefresh(skillOf(s, team))) return cur;
  const plan = buildPlan(s, team);
  plans[team] = plan;
  return plan;
}

function buildPlan(s: MatchState, team: 0 | 1): AiTeamPlan {
  const skill = skillOf(s, team);
  const lag = reactionLag(skill);
  const b = s.ball;
  const owner = b.owner >= 0 ? s.players[b.owner] : null;
  const human = s.humanTeam === team ? s.controlled : -1;
  const icpt: (AiInterception | null)[] = s.players.map(() => null);
  const mark: number[] = s.players.map(() => -1);
  const mates = s.players.filter((m) => m.team === team && m.role !== 'GK' && m.stun === 0);
  let attacking: boolean;
  let chaser = -1;
  let bestUs = Infinity;
  let bestThem = Infinity;
  let focus: Vec;

  if (owner) {
    focus = clampToPitch(sub(owner.pos, scale(owner.vel, lag)), 0.5);
    attacking = owner.team === team;
    if (!attacking) {
      const goal = ownGoal(team);
      const press = add(focus, scale(norm(sub(goal, focus)), 0.8));
      let best: MatchPlayer | null = null;
      for (const m of mates) if (!best || dist(m.pos, press) < dist(best.pos, press)) best = m;
      chaser = best && best.i !== human ? best.i : -1;
    }
  } else {
    const seen = clampToPitch(sub(b.pos, scale(b.vel, lag)), 0.3);
    const traj = trajectory(seen, b.vel, b.z, b.vz);
    let quickest: MatchPlayer | null = null;
    for (const m of s.players) {
      const ic = interceptOn(s, m, traj);
      icpt[m.i] = ic;
      if (m.team === team) {
        if (m.role !== 'GK' && m.stun === 0 && ic.t < bestUs) {
          bestUs = ic.t;
          quickest = m;
        }
      } else if (ic.t < bestThem) bestThem = ic.t;
    }
    const receiver = b.receiver >= 0 ? s.players[b.receiver] : null;
    const lastOurs = b.lastTouch >= 0 && s.players[b.lastTouch].team === team;
    if (receiver && receiver.team === team && receiver.role !== 'GK' && receiver.stun === 0) {
      const rt = icpt[receiver.i]!.t;
      attacking = rt <= bestThem + 0.25;
      chaser = rt <= bestUs + 0.3 ? receiver.i : quickest?.i ?? -1;
    } else {
      attacking = bestUs < bestThem - (lastOurs ? 0.1 : 0.45);
      chaser = quickest?.i ?? -1;
    }
    if (chaser === human) chaser = -1;
    const fi = chaser >= 0 ? icpt[chaser]! : quickest ? icpt[quickest.i]! : null;
    focus = fi ? fi.pt : seen;
  }

  let cover = -1;
  if (!attacking) {
    // Defending: mark the most dangerous attackers first, goal-side, each with
    // the defender whose zone is nearest. The carrier belongs to the chaser.
    const goal = ownGoal(team);
    const attackers = s.players
      .filter((o) => o.team !== team && o.role !== 'GK' && o.i !== b.owner && teamX(team, o.pos.x) < 0.2 * skill)
      .sort((x, y) => dist(x.pos, goal) - dist(y.pos, goal));
    const free = mates.filter((m) => m.i !== chaser && m.i !== human);
    const radius = 13 + 7 * skill;
    for (const a of attackers) {
      let best: MatchPlayer | null = null;
      let bestCost = radius;
      for (const d of free) {
        if (mark[d.i] >= 0) continue;
        const cost = dist(zoneAnchor(d, focus), a.pos) * 0.55 + dist(d.pos, a.pos) * 0.45;
        if (cost < bestCost) {
          bestCost = cost;
          best = d;
        }
      }
      if (best) mark[best.i] = a.i;
    }
    // The deepest unassigned player sweeps.
    let deepest = Infinity;
    for (const d of free) {
      if (mark[d.i] >= 0) continue;
      const x = teamX(team, d.pos.x);
      if (x < deepest) {
        deepest = x;
        cover = d.i;
      }
    }
  }
  return { tick: s.tick, attacking, chaser, focus, icpt, bestUs, bestThem, mark, cover };
}

/** Where a player's slot sits when defending, used to decide marking zones. */
function zoneAnchor(p: MatchPlayer, focus: Vec): Vec {
  return formationTarget(p, false, focus);
}

function formationTarget(p: MatchPlayer, inPossession: boolean, focus: Vec): Vec {
  const slot = FORMATION[p.slot];
  const bx = teamX(p.team, focus.x);
  const by = focus.y / PITCH_H;
  let nx = slot.x + (bx - 0.45) * 0.55 + (inPossession ? 0.1 : -0.05);
  if (p.role === 'DEF' && !inPossession) nx = Math.min(nx, bx - 0.04);
  if (p.role === 'FWD' && inPossession) nx = Math.max(nx, Math.min(0.9, bx + 0.08));
  nx = clamp(nx + p.jitter.x, 0.06, 0.92);
  const ny = clamp(slot.y * 0.75 + by * 0.25 + p.jitter.y, 0.06, 0.94);
  return fromTeam(p.team, nx, ny);
}

// ---------------------------------------------------------------------------
// Passing

export interface PassOption {
  receiver: MatchPlayer;
  target: Vec;
  score: number;
  /** True for a pass into space ahead of a runner rather than to feet. */
  through: boolean;
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

/**
 * Score a pass from the ball to `target` for receiver m. Higher is better;
 * about 0 is a safe sideways ball, below -1 is likely to be cut out.
 */
function evalPass(s: MatchState, p: MatchPlayer, m: MatchPlayer, target: Vec, through: boolean): number {
  const team = p.team;
  const from = s.ball.pos;
  const d = dist(from, target);
  if (d < 3.5 || d > 34) return -Infinity;
  const spd = passSpeed(d, p.attrs.passing) * (through ? 1.05 : 1);
  const vEff = spd * 0.85;
  const tBallEnd = d / vEff;
  const tRecv = Math.max(0, dist(m.pos, target) - 0.9) / runSpeed(m) + 0.1;
  const ab = sub(target, from);
  const d2 = d * d;
  let laneM = Infinity;
  let arriveM = Infinity;
  for (const o of s.players) {
    if (o.team === team || o.stun > 20) continue;
    const reach = o.role === 'GK' && inOwnBox(o.team, o.pos) ? 1.5 : 0.95;
    const oSp = runSpeed(o) * 0.95;
    const u = clamp(dot(sub(o.pos, from), ab) / d2, 0, 1);
    const proj = add(from, scale(ab, u));
    const perp = dist(o.pos, proj);
    const tBall = (u * d) / vEff;
    const tO = Math.max(0, perp - reach) / oSp + 0.18;
    if (u > 0.04) laneM = Math.min(laneM, tO - tBall);
    const tOA = Math.max(0, dist(o.pos, target) - reach) / oSp + 0.18;
    arriveM = Math.min(arriveM, tOA - Math.max(tRecv, tBallEnd));
  }
  const tx = teamX(team, target.x);
  const gain = (tx - teamX(team, from.x)) * PITCH_W;
  const dGoal = dist(target, oppGoal(team));
  let score = gain * 0.07 + tx * 1.1 + (dGoal < 18 ? (18 - dGoal) * 0.07 : 0);
  score += clamp(laneM, -0.6, 0.6) * 3 + clamp(arriveM, -0.6, 0.8) * 2 - d * 0.02;
  if (m.role === 'GK') score -= laneM > 0.6 && arriveM > 0.5 ? 1.2 : 4;
  // Never stroke it across the face of your own goal unless it's clearly safe.
  const own = ownGoal(team);
  if (distToSegment(own, from, target) < 10 && (laneM < 0.5 || arriveM < 0.3)) score -= 3.5;
  if (tx < 0.2 && Math.abs(target.y - MID_Y) < 10) score -= 1;
  // Only when the runner clearly wins the race; a through ball that is merely possible is a giveaway.
  if (through && arriveM < 0.3) score -= 2.5;
  // Switch of play: a long lateral ball out of a crowded side.
  if (Math.abs(target.y - from.y) > 15) {
    let crowd = 0;
    for (const o of s.players) if (o.team !== team && dist(o.pos, from) < 9) crowd++;
    if (crowd >= 2) score += 0.6;
  }
  return score;
}

/**
 * A CPU through ball: into the space a few metres ahead of the runner, so it
 * arrives in stride. Shorter than kicks.throughTarget, which leads generously
 * for a human who can adjust the run.
 */
function cpuThroughTarget(from: Vec, m: MatchPlayer, passing: number): Vec {
  const d = dist(from, m.pos);
  const tBall = d / (passSpeed(d, passing) * 1.05 * 0.8);
  const vr = len(m.vel);
  const run = vr > 1.2 ? scale(m.vel, 1 / vr) : norm(add({ x: attackDir(m.team), y: 0 }, scale(norm(sub(oppGoal(m.team), m.pos)), 0.5)));
  const lead = clamp(Math.max(vr, 3) * tBall + 1.5, 3, 8);
  return clampToPitch(add(m.pos, scale(run, lead)), 1.2);
}

export function bestPassOption(s: MatchState, p: MatchPlayer, noise = 0): PassOption | null {
  let best: PassOption | null = null;
  const dir = attackDir(p.team);
  const consider = (m: MatchPlayer, target: Vec, through: boolean) => {
    const sc = evalPass(s, p, m, target, through);
    if (sc === -Infinity) return;
    const score = sc + (noise > 0 ? gauss(s.rng) * noise : 0);
    if (!best || score > best.score) best = { receiver: m, target, score, through };
  };
  for (const m of s.players) {
    if (m.team !== p.team || m.i === p.i || m.stun > 0) continue;
    consider(m, leadTarget(p.pos, m, p.attrs.passing), false);
    if (m.role === 'GK') continue;
    // Through ball into space ahead of a runner, or ahead of a forward who is level or beyond.
    const fwdSpeed = m.vel.x * dir;
    const mx = teamX(p.team, m.pos.x);
    // Through balls break lines from our own half. Higher up, a carry into
    // the box or a shot is worth more (measured: they cost goals there).
    if (teamX(p.team, p.pos.x) > 0.45 || !(fwdSpeed > 1.5 || mx > teamX(p.team, p.pos.x) + 0.04)) continue;
    consider(m, cpuThroughTarget(s.ball.pos, m, p.attrs.passing), true);
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

// ---------------------------------------------------------------------------
// Shooting

interface ShotOption {
  /** Rough chance of scoring, 0..1. */
  xg: number;
  target: Vec;
  power: number;
  chip: boolean;
}

function evalShot(s: MatchState, p: MatchPlayer): ShotOption {
  const team = p.team;
  const goal = oppGoal(team);
  const gk = goalkeeper(s, team === 0 ? 1 : 0);
  const dGoal = dist(p.pos, goal);
  const dx = Math.abs(goal.x - p.pos.x);
  // Angle the goal mouth subtends.
  const a1 = Math.atan2(GOAL_TOP - p.pos.y, dx);
  const a2 = Math.atan2(GOAL_BOTTOM - p.pos.y, dx);
  const angle = Math.abs(a2 - a1);
  // Aim at the post the keeper is further from.
  const inset = 0.55;
  const top = { x: goal.x, y: GOAL_TOP + inset };
  const bottom = { x: goal.x, y: GOAL_BOTTOM - inset };
  const kTop = distToSegment(gk.pos, p.pos, top);
  const kBottom = distToSegment(gk.pos, p.pos, bottom);
  const target = kTop > kBottom ? top : bottom;
  const keeperGap = Math.max(kTop, kBottom);
  let blockers = 0;
  for (const o of s.players) {
    if (o.team === team || o.role === 'GK') continue;
    if (distToSegment(o.pos, p.pos, target) < 0.9 && dist(o.pos, p.pos) < dGoal) blockers++;
  }
  // Fitted to headless conversion rates by distance (about 50% inside 6 m,
  // 20% at 6-12 m, 4% at 12-18 m), then scaled by how much of the goal is
  // visible, where the keeper is, the shooter and anyone in the way.
  const central = clamp(angle / (2 * Math.atan(GOAL_HALF / Math.max(dGoal, 0.5))), 0.15, 1);
  const keeperFactor = clamp(0.55 + keeperGap * 0.22, 0.55, 1.3);
  const xg = clamp(0.85 * Math.exp(-dGoal / 5) * central * (0.55 + 0.7 * p.attrs.shooting) * keeperFactor * Math.pow(0.4, blockers), 0, 0.95);
  const power = clamp(0.8 + dGoal * 0.01, 0.6, 0.97);
  return { xg, target, power, chip: false };
}

/** A chip over a keeper who has come off his line. Null when it isn't on. */
function evalChip(s: MatchState, p: MatchPlayer): ShotOption | null {
  const team = p.team;
  const goal = oppGoal(team);
  const gk = goalkeeper(s, team === 0 ? 1 : 0);
  const dGoal = dist(p.pos, goal);
  if (dGoal < 8 || dGoal > 22) return null;
  const off = Math.abs(gk.pos.x - goal.x);
  if (off < 3.2) return null;
  // The keeper must be between shooter and goal, and the shot angle decent.
  if (distToSegment(gk.pos, p.pos, goal) > 2.5 || Math.abs(p.pos.y - MID_Y) > dGoal * 0.7) return null;
  const dir = attackDir(team);
  const target = { x: goal.x + dir * 0.8, y: clamp(p.pos.y, GOAL_TOP + 1, GOAL_BOTTOM - 1) * 0.3 + MID_Y * 0.7 };
  const d = dist(p.pos, target);
  const power = clamp((d - 6) / 30 + 0.04, 0.1, 1);
  const plan = chipPlan(p.pos, target, power);
  // Nobody but the keeper should be under its flight near the landing.
  for (const o of s.players) {
    if (o.team === team || o.role === 'GK') continue;
    if (dist(o.pos, plan.landing) < 3) return null;
  }
  const xg = clamp((0.18 + 0.05 * (off - 3.2)) * (0.6 + 0.6 * p.attrs.shooting), 0, 0.5);
  return { xg, target, power, chip: true };
}

// ---------------------------------------------------------------------------
// The ball carrier

function passIntent(s: MatchState, p: MatchPlayer, opt: PassOption, skill: number): Intent {
  // Execution error on top of the attribute-based error in match.ts.
  const d = dist(p.pos, opt.target);
  const err = (1 - skill) * 0.02 * d;
  const target = clampToPitch(add(opt.target, { x: gauss(s.rng) * err, y: gauss(s.rng) * err }), 0.8);
  p.ai!.mode = 'none';
  return { move: p.facing, throttle: 0.6, action: { kind: 'pass', target, receiver: opt.receiver.i, through: opt.through } };
}

function shootIntent(s: MatchState, p: MatchPlayer, shot: ShotOption, skill: number): Intent {
  const target = { x: shot.target.x, y: shot.target.y + gauss(s.rng) * (0.25 + 0.8 * (1 - skill)) };
  p.ai!.mode = 'none';
  const move = norm(sub(oppGoal(p.team), p.pos));
  if (shot.chip) return { move, throttle: 0.8, action: { kind: 'chip', target, power: shot.power } };
  return { move, throttle: 1, action: { kind: 'shoot', target, power: shot.power } };
}

function ownerIntent(s: MatchState, p: MatchPlayer): Intent {
  const mem = memOf(s, p);
  const skill = skillOf(s, p.team);
  const goal = oppGoal(p.team);
  const dir = attackDir(p.team);
  const px = teamX(p.team, p.pos.x);

  let nearest: MatchPlayer | null = null;
  let pressure = Infinity;
  for (const o of s.players) {
    if (o.team === p.team) continue;
    const d = dist(o.pos, p.pos);
    if (d < pressure) {
      pressure = d;
      nearest = o;
    }
  }

  // Sharper players notice a closing defender sooner.
  if (pressure < 2.2 && p.aiTimer > 2 + Math.round(6 * (1 - skill))) p.aiTimer = 2 + Math.round(6 * (1 - skill));

  if (p.aiTimer <= 0) {
    p.aiTimer = decisionInterval(s, p);
    const noise = 0.15 + 0.4 * (1 - skill) * (1 - skill);
    let shot = evalShot(s, p);
    const chipShot = skill > 0.3 && p.attrs.shooting > 0.5 ? evalChip(s, p) : null;
    if (chipShot && chipShot.xg > shot.xg && chance(s.rng, 0.4 + 0.4 * skill)) shot = chipShot;
    const shotScore = shot.xg * (1 + gauss(s.rng) * (0.15 + 0.5 * (1 - skill)));
    const opt = bestPassOption(s, p, noise);
    const passScore = opt ? opt.score : -Infinity;

    if (shotScore > SHOOT_XG || (shotScore > SHOOT_XG * 0.6 && pressure < 2 && passScore < 1.2)) return shootIntent(s, p, shot, skill);

    // How much open grass is ahead to carry into.
    let clear = 9;
    for (const o of s.players) {
      if (o.team === p.team) continue;
      const to = sub(o.pos, p.pos);
      const d = len(to);
      if (d < 9 && to.x * dir > -0.5) clear = Math.min(clear, d);
    }
    const carryScore = clamp((clear - 2.5) / 4, 0, 1) * (3 + 4 * clamp((px - 0.55) * 4, 0, 1));

    if (opt) {
      const underPressure = pressure < 2.3 && passScore > -0.4;
      const better = passScore > carryScore + 1.5 - 0.4 * p.attrs.passing;
      const deep = px < 0.35 && pressure < 5.5 && passScore > -0.8;
      if (underPressure || better || deep) return passIntent(s, p, opt, skill);
    }

    // Take a man on: one defender in front, nobody else close, a good dribbler.
    if (nearest && pressure < 4.5 && px > 0.35 && p.attrs.dribbling > 0.55) {
      let others = 0;
      for (const o of s.players) if (o.team !== p.team && o.i !== nearest.i && dist(o.pos, p.pos) < 7) others++;
      const ahead = (nearest.pos.x - p.pos.x) * dir > -0.3;
      if (others === 0 && ahead && chance(s.rng, (p.attrs.dribbling - 0.45) * (0.6 + 0.8 * skill))) {
        const roomUp = nearest.pos.y - 0;
        const roomDown = PITCH_H - nearest.pos.y;
        const side = roomUp > roomDown ? -1 : 1;
        mem.mode = 'takeon';
        mem.modeTicks = 26;
        mem.modeTarget = clampToPitch({ x: nearest.pos.x + dir * 4, y: nearest.pos.y + side * 2.4 }, 1.5);
      }
    }

    // Shield on the touchline when pressed and nothing is on.
    const nearLine = p.pos.y < 4.5 || p.pos.y > PITCH_H - 4.5;
    if (mem.mode === 'none' && nearest && pressure < 2.4 && nearLine && passScore < 0.6) {
      mem.mode = 'shield';
      mem.modeTicks = 18 + Math.round(12 * skill);
      p.aiTimer = Math.min(p.aiTimer, 5);
    }

    if (px < 0.25 && pressure < 2 && passScore < -0.6) {
      const clearTo = { x: ownGoal(p.team).x + dir * range(s.rng, 26, 34), y: p.pos.y < MID_Y ? range(s.rng, 3, 10) : range(s.rng, PITCH_H - 10, PITCH_H - 3) };
      return { move: p.facing, throttle: 0.6, action: { kind: 'shoot', target: clearTo, power: 0.8 } };
    }
  }

  if (mem.mode === 'takeon' && mem.modeTarget && mem.modeTicks-- > 0) {
    if (dist(p.pos, mem.modeTarget) < 1) mem.mode = 'none';
    return { move: norm(sub(mem.modeTarget, p.pos)), throttle: 1, sprint: sprintOk(s, p, true) };
  }
  if (mem.mode === 'shield' && nearest && mem.modeTicks-- > 0) {
    // Body between ball and defender: drift away from them, along the boards.
    const away = norm(sub(p.pos, nearest.pos));
    const along = { x: -dir * 0.4, y: 0 };
    return { move: norm(add(away, along)), throttle: 0.45 };
  }
  mem.mode = 'none';

  // Carry toward goal, steering around opponents ahead.
  let desired = norm(sub(goal, p.pos));
  const look = 4 + 2 * skill;
  for (const o of s.players) {
    if (o.team === p.team) continue;
    const to = sub(o.pos, p.pos);
    const d = len(to);
    if (d > look || dot(to, desired) <= 0) continue;
    const side = to.x * desired.y - to.y * desired.x > 0 ? 1 : -1;
    const perp = { x: -desired.y * side, y: desired.x * side };
    desired = add(desired, scale(perp, ((look - d) / look) * 1.3));
  }
  // Stay off the boards.
  if (p.pos.y < 3) desired.y += 0.6;
  if (p.pos.y > PITCH_H - 3) desired.y -= 0.6;
  return { move: norm(desired), throttle: 1, sprint: sprintOk(s, p, pressure > 4 && px > 0.4 && px < 0.85) };
}

// ---------------------------------------------------------------------------
// Goalkeeper

function gkIntent(s: MatchState, p: MatchPlayer): Intent {
  const ball = s.ball;
  const own = ownGoal(p.team);
  const dir = attackDir(p.team);
  const skill = skillOf(s, p.team);
  memOf(s, p);

  if (ball.owner === p.i) {
    p.holdTicks++;
    const inBox = inOwnBox(p.team, p.pos);
    const hold = inBox ? Math.round(48 - 26 * skill) : 4;
    if (p.holdTicks > hold) {
      // Distribute: prefer the open full-back, then a midfielder.
      let best: PassOption | null = null;
      for (const m of s.players) {
        if (m.team !== p.team || m.i === p.i || m.stun > 0) continue;
        const target = leadTarget(p.pos, m, p.attrs.passing);
        let sc = evalPass(s, p, m, target, false);
        if (sc === -Infinity) continue;
        sc += (m.role === 'DEF' ? 1.2 : m.role === 'MID' ? 0.4 : 0) + gauss(s.rng) * (1 - skill) * 0.8;
        if (!best || sc > best.score) best = { receiver: m, target, score: sc, through: false };
      }
      if (best && best.score > -0.3) return passIntent(s, p, best, skill);
      // Nothing on: kick long to the emptier wing.
      let topCrowd = 0;
      for (const o of s.players) if (o.team !== p.team && o.pos.y < MID_Y) topCrowd++;
      const y = topCrowd <= 2 ? range(s.rng, 4, 12) : range(s.rng, PITCH_H - 12, PITCH_H - 4);
      return { move: IDLE.move, throttle: 0, action: { kind: 'shoot', target: { x: own.x + dir * range(s.rng, 28, 36), y }, power: 0.78 } };
    }
    return IDLE;
  }

  const plan = teamPlan(s, p.team);
  const lag = reactionLag(skill);
  const owner = ball.owner >= 0 ? s.players[ball.owner] : null;

  // Angle play: stand on the line from goal centre to the ball.
  const seen = owner ? sub(owner.pos, scale(owner.vel, lag)) : sub(ball.pos, scale(ball.vel, lag));
  const toBall = sub(seen, own);
  const dB = len(toBall);
  const threatened = !plan.attacking;
  let depth = threatened ? clamp(0.8 + dB * 0.07, 1.1, 3) : clamp(1.5 + dB * 0.05, 1.5, 4.2);
  // One-on-one: carrier through with nobody between him and goal: come out to narrow the angle.
  if (owner && owner.team !== p.team && dB < 16) {
    let covered = false;
    for (const m of s.players) {
      if (m.team !== p.team || m.role === 'GK') continue;
      if (distToSegment(m.pos, owner.pos, own) < 1.5) covered = true;
    }
    if (!covered) depth = clamp(dB * (0.25 + 0.15 * skill), depth, 5);
  }
  let target = add(own, scale(norm(dB > 0.1 ? toBall : { x: dir, y: 0 }), depth));
  // Weak keepers drift back toward the middle of the goal.
  const lazy = (1 - skill) * 0.35;
  target = add(scale(target, 1 - lazy), scale({ x: own.x + dir * 1.2, y: MID_Y }, lazy));
  const nx = clamp(teamX(p.team, target.x) * PITCH_W, 0.7, BOX_DEPTH - 0.8);
  const spot = { x: own.x + dir * nx, y: clamp(target.y, GOAL_TOP - 1.2, GOAL_BOTTOM + 1.2) };

  // Shot or loose ball heading at goal: shift from the angle spot toward its
  // path. Only partly: how far a keeper gets across is his reflexes.
  if (!owner && ball.vel.x * dir < -3) {
    const tLine = (own.x - ball.pos.x) / ball.vel.x;
    const yCross = ball.pos.y + ball.vel.y * tLine;
    if (tLine > 0 && tLine < 1.6 && yCross > GOAL_TOP - 1.5 && yCross < GOAL_BOTTOM + 1.5) {
      const lineX = Math.abs(p.pos.x - own.x) < 0.6 ? own.x + dir * 0.6 : p.pos.x;
      const tx = (lineX - ball.pos.x) / ball.vel.x;
      const pathY = tx > 0 ? ball.pos.y + ball.vel.y * tx : yCross;
      const react = clamp(0.3 + 0.45 * p.attrs.goalkeeping + 0.15 * skill, 0, 1);
      const y = spot.y + (clamp(pathY, GOAL_TOP - 0.8, GOAL_BOTTOM + 0.8) - spot.y) * react;
      return seek(p, { x: lineX, y }, 0.5);
    }
  }

  // Sweep: a loose ball I reach first, near my box (through balls, loose touches).
  if (!owner) {
    const mine = plan.icpt[p.i];
    const receiver = ball.receiver >= 0 ? s.players[ball.receiver] : null;
    const toTeammate = receiver && receiver.team === p.team && receiver.i !== p.i;
    if (mine && !toTeammate && teamX(p.team, mine.pt.x) * PITCH_W < BOX_DEPTH + 5 + 4 * skill && Math.abs(mine.pt.y - MID_Y) < 11) {
      const margin = 0.25 - 0.25 * skill;
      if (mine.t + margin < plan.bestThem && mine.t <= plan.bestUs + 0.2) return seek(p, mine.pt, 0.8);
    }
  }

  return seek(p, spot, 1.2);
}

// ---------------------------------------------------------------------------
// Off the ball, team in possession

function supportTarget(s: MatchState, p: MatchPlayer, plan: AiTeamPlan, carrier: MatchPlayer | null): Vec {
  const mem = memOf(s, p);
  if (mem.target && mem.attacking && mem.retarget-- > 0) return mem.target;
  const skill = skillOf(s, p.team);
  mem.attacking = true;
  mem.retarget = Math.round(14 + 22 * (1 - skill) + next(s.rng) * 10);

  const team = p.team;
  const dir = attackDir(team);
  const focus = plan.focus;
  const fx = teamX(team, focus.x);
  const anchor = formationTarget(p, true, focus);
  const fwd = { x: dir, y: 0 };
  const cands: Vec[] = [anchor, add(anchor, { x: dir * 5, y: 0 }), add(anchor, { x: 0, y: 5 }), add(anchor, { x: 0, y: -5 })];

  // Rest defence: the defender further from the ball stays home; the near one may overlap.
  let restDef = false;
  if (p.role === 'DEF') {
    const other = s.players.find((m) => m.team === team && m.role === 'DEF' && m.i !== p.i);
    restDef = !!other && Math.abs(other.pos.y - focus.y) < Math.abs(p.pos.y - focus.y);
  }
  const attacker = p.role !== 'DEF' || (!restDef && fx > 0.45);

  if (attacker) {
    // Wide channel on this player's side.
    const wideY = anchor.y < MID_Y ? 3.2 : PITCH_H - 3.2;
    cands.push({ x: anchor.x + dir * 4, y: wideY });
    if (p.role === 'DEF') cands.push({ x: focus.x + dir * 7, y: wideY });
    // A run in behind the last outfield defender (there is no offside on the boards).
    let line = 0;
    for (const o of s.players) if (o.team !== team && o.role !== 'GK') line = Math.max(line, teamX(team, o.pos.x));
    const behindX = Math.min(0.9, Math.max(line + 3.5 / PITCH_W, fx + 0.05));
    if (p.role !== 'DEF') {
      cands.push(fromTeam(team, behindX, anchor.y / PITCH_H));
      cands.push(fromTeam(team, behindX, clamp((focus.y + (anchor.y < focus.y ? -8 : 8)) / PITCH_H, 0.08, 0.92)));
    }
  }
  // Short options either side of the carrier, and a safe ball behind.
  for (const side of [-1, 1]) {
    cands.push(add(focus, scale(rotate(fwd, side * 0.9), 8)));
    cands.push(add(focus, scale(rotate(fwd, side * 2.1), 7)));
  }

  const oppG = oppGoal(team);
  const roleW = p.role === 'FWD' ? 1.2 : p.role === 'MID' ? 1 : 0.6;
  const noise = 0.15 + 0.9 * (1 - skill);
  let best = anchor;
  let bestScore = -Infinity;
  for (const raw of cands) {
    const c = clampToPitch(raw, 1.5);
    let space = 9;
    let lane = 4;
    for (const o of s.players) {
      if (o.team === team) continue;
      space = Math.min(space, dist(o.pos, c));
      lane = Math.min(lane, distToSegment(o.pos, focus, c));
    }
    const cx = teamX(team, c.x);
    let score = space * 0.35 + lane * 0.45 - (lane < 1.2 ? 2 : 0) + cx * PITCH_W * 0.06 * roleW;
    const dG = dist(c, oppG);
    if (p.role !== 'DEF' && dG < 16) score += (16 - dG) * 0.06;
    for (const m of s.players) {
      if (m.team !== team || m.i === p.i || m.role === 'GK') continue;
      const spot = m.i === carrier?.i ? focus : m.ai?.target && m.ai.attacking ? m.ai.target : m.pos;
      const d = dist(c, spot);
      if (d < 7) score -= (7 - d) * (m.i === carrier?.i ? 0.6 : 0.35);
    }
    const dF = dist(c, focus);
    if (dF > 26) score -= (dF - 26) * 0.15;
    score -= dist(p.pos, c) * 0.05 + dist(anchor, c) * (p.role === 'DEF' ? 0.09 : 0.04);
    if (restDef && cx > fx - 0.18) score -= 2;
    score += gauss(s.rng) * noise;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  mem.target = best;
  return best;
}

// ---------------------------------------------------------------------------
// Off the ball, defending

function defendIntent(s: MatchState, p: MatchPlayer, plan: AiTeamPlan, owner: MatchPlayer | null): Intent {
  const mem = memOf(s, p);
  mem.attacking = false;
  mem.target = null;
  const skill = skillOf(s, p.team);
  const lag = reactionLag(skill);
  const own = ownGoal(p.team);
  const cap = 0.82 + 0.18 * skill;

  if (owner && p.i === plan.chaser) {
    const seen = sub(owner.pos, scale(owner.vel, lag));
    const cut = add(add(seen, scale(owner.vel, 0.25)), scale(norm(sub(own, seen)), 0.8));
    const d = dist(p.pos, owner.pos);
    // Good defenders wait until they're in range; poor ones lunge early.
    const range_ = 1.45 + 0.5 * (1 - skill);
    if (d < range_ && p.tackleCd === 0 && p.aiTimer <= 0) {
      p.aiTimer = decisionInterval(s, p);
      if (chance(s.rng, 0.35 + 0.35 * p.attrs.defending + 0.15 * skill)) return { move: norm(sub(owner.pos, p.pos)), throttle: 1, action: { kind: 'tackle', target: owner.pos } };
    }
    return { ...seek(p, cut, 1), sprint: sprintOk(s, p, d > 2.5 && teamX(p.team, owner.pos.x) < 0.5) };
  }

  const target = plan.mark[p.i];
  if (target >= 0) {
    const a = s.players[target];
    const seen = add(sub(a.pos, scale(a.vel, lag)), scale(a.vel, 0.15 + 0.2 * skill));
    const goalSide = norm(sub(own, seen));
    const toBall = norm(sub(plan.focus, seen));
    const dGoal = dist(seen, own);
    const tight = clamp(dGoal * 0.07, 1.1, 2.8) * (1.35 - 0.45 * skill);
    const spot = add(seen, scale(norm(add(scale(goalSide, 0.65), scale(toBall, 0.35))), tight));
    // Step in to intercept a pass aimed at my man.
    if (!owner && s.ball.receiver === target) {
      const ic = plan.icpt[p.i];
      const theirs = plan.icpt[target];
      if (ic && theirs && ic.t + (1 - skill) * 0.8 < theirs.t + 0.1) return seek(p, ic.pt, 1);
    }
    return seek(p, clampToPitch(spot, 0.8), 1.5, cap);
  }

  if (p.i === plan.cover && skill >= 0.8) {
    const f = plan.focus;
    const spot = add(own, scale(sub(f, own), 0.4));
    const nx = Math.max(teamX(p.team, spot.x), 5 / PITCH_W);
    return seek(p, fromTeam(p.team, nx, clamp(spot.y / PITCH_H, 0.15, 0.85)), 2, cap);
  }
  return seek(p, formationTarget(p, false, plan.focus), 3, 0.9 * cap);
}

// ---------------------------------------------------------------------------

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
  const mem = memOf(s, p);
  mem.mode = 'none';

  const plan = teamPlan(s, p.team);
  const owner = ball.owner >= 0 ? s.players[ball.owner] : null;

  if (!owner && p.i === plan.chaser) {
    const ic = plan.icpt[p.i];
    return { ...seek(p, ic ? ic.pt : ball.pos, 0.8), sprint: sprintOk(s, p, plan.bestThem - plan.bestUs < 0.6) };
  }
  if (plan.attacking) {
    const carrier = owner && owner.team === p.team ? owner : null;
    const skill = skillOf(s, p.team);
    const target = supportTarget(s, p, plan, carrier);
    const runCap = dist(target, p.pos) > 8 ? 1 : 0.9 + 0.1 * skill;
    const run = dist(target, p.pos) > 8 && teamX(p.team, target.x) > teamX(p.team, p.pos.x) + 0.08;
    return { ...seek(p, target, 2.5, runCap), sprint: sprintOk(s, p, run) };
  }
  return defendIntent(s, p, plan, owner && owner.team !== p.team ? owner : null);
}
