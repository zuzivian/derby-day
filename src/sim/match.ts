// Fixed-timestep, seeded match simulation. step() is a pure function of
// (state, human inputs): no DOM, no clocks, no Math.random. That property is
// what makes server authority, replays and lockstep/rollback netcode possible.
//
// Either team, or both, can have a human. Each human steers one player of their
// team (MatchState.controlled[team]); the rest of that team is CPU-driven.
//
// Eleven-a-side under the Laws of the Game: the ball goes out of play, and
// restarts, offside, fouls and cards are applied by rules.ts. Phases:
//   kickoff   players frozen in their halves, then 'play' with the taker on the ball
//   play      live ball
//   restart   dead ball: rules.ts Restart (whistle -> setup -> ready -> taken)
//   goal, halftime, fulltime

import { aiIntent, passSpeed, penaltyDive, restartAction, restartIntent } from './ai.ts';
import {
  AIR_DRAG,
  BALL_R,
  BOUNCE_DAMP,
  CHIP_Z0,
  CENTRE_R,
  DT,
  formationOf,
  GOAL_BAR_H,
  GRAVITY,
  HEAD_Z,
  KEEPER_REACH_Z,
  REACH_Z,
  rollDecel,
  RESTART_HUMAN_WAIT,
  RESTART_SETUP_MAX,
  RESTART_SETUP_MIN,
  RESTART_WHISTLE,
  RESTART_WHISTLE_FOUL,
  RUN_OFF,
  SPRINT_DRAIN,
  SPRINT_MULT,
  THROW_Z0,
  WINDED_BELOW,
  WINDED_RECOVER,
  GOAL_BOTTOM,
  GOAL_DEPTH,
  GOAL_PAUSE,
  GOAL_TOP,
  GOAL_W,
  HALF_SECONDS,
  HALFTIME_PAUSE,
  KICKOFF_PAUSE,
  PITCH_H,
  PITCH_W,
  PLAYER_R,
  TEAM_SIZE,
  TICK_HZ,
} from './constants.ts';
import { attackDir, fromTeam, goalkeeper, inGoalMouth, inOwnBox, oppGoal, ownGoal, slotOf, teamX } from './field.ts';
import { humanIntent, updateControl } from './human.ts';
import { chipPlan, loftPlan } from './kicks.ts';
import {
  awardRestart,
  ballOut,
  chooseTaker,
  downgradeDogso,
  enforceRestartPositions,
  eventBase,
  fixControlled,
  flushPendingCards,
  judgeFoul,
  matchMinute,
  matchSeconds,
  moveReferee,
  NO_OFFSIDE,
  noteBallPlayed,
  offsideOnTouch,
  pushEvent,
  restartBallZ,
  takerSpot,
  tickAdvantage,
} from './rules.ts';
import { gauss, makeRng, next, range } from './rng.ts';
import type { Action, FoulSeverity, HumanInput, Intent, MatchPlayer, MatchState, Restart, TeamInputs, TeamSetup, TeamStats } from './types.ts';
import { add, clamp, dist, dot, len, norm, rotate, scale, sub, type Vec } from './vec.ts';

export { matchMinute, matchSeconds };

export interface MatchOptions {
  seed: number;
  home: TeamSetup;
  away: TeamSetup;
  halfSeconds?: number;
  /** Shorthand for one human: the team they play for, or -1 for CPU vs CPU. Default 0. */
  humanTeam?: 0 | 1 | -1;
  /** Which teams have a human. Overrides `humanTeam` when given. */
  humans?: [boolean, boolean];
}

/** The teams with a human, from either form of MatchOptions. */
function humansOf(o: MatchOptions): [boolean, boolean] {
  if (o.humans) return [o.humans[0], o.humans[1]];
  const t = o.humanTeam ?? 0;
  return [t === 0, t === 1];
}

/** A human aims with the pointer, so their passes and lofted balls scatter this fraction of what a CPU's do. */
const HUMAN_AIM = 0.4;

const emptyStats = (): TeamStats => ({
  shots: 0,
  onTarget: 0,
  passes: 0,
  tackles: 0,
  possessionTicks: 0,
  fouls: 0,
  yellows: 0,
  reds: 0,
  corners: 0,
  offsides: 0,
  throwIns: 0,
  goalKicks: 0,
  freeKicks: 0,
  penalties: 0,
});

export function createMatch(o: MatchOptions): MatchState {
  if (o.home.players.length !== TEAM_SIZE || o.away.players.length !== TEAM_SIZE) {
    throw new Error(`Each team needs exactly ${TEAM_SIZE} players`);
  }
  const players: MatchPlayer[] = [];
  ([o.home, o.away] as const).forEach((t, team) => {
    const slots = formationOf(t.formation);
    t.players.forEach((ps, slot) => {
      players.push({
        i: players.length,
        team: team as 0 | 1,
        slot,
        role: slots[slot].role,
        sub: slots[slot].sub,
        id: ps.id,
        name: ps.name,
        number: ps.number,
        attrs: ps.attrs,
        pos: { x: 0, y: 0 },
        vel: { x: 0, y: 0 },
        facing: { x: attackDir(team as 0 | 1), y: 0 },
        energy: 1,
        sprinting: false,
        winded: false,
        stun: 0,
        tackleCd: 0,
        kickCd: 0,
        aiTimer: 0,
        jitter: { x: 0, y: 0 },
        jitterTimer: 0,
        holdTicks: 0,
        yellow: 0,
        sentOff: false,
      });
    });
  });
  const humans = humansOf(o);
  const firstFwd = (team: 0 | 1) => players.find((p) => p.team === team && p.role === 'FWD')?.i ?? team * TEAM_SIZE + TEAM_SIZE - 1;
  const s: MatchState = {
    tick: 0,
    rng: makeRng(o.seed),
    teams: [o.home, o.away],
    players,
    ball: {
      pos: { x: PITCH_W / 2, y: PITCH_H / 2 },
      vel: { x: 0, y: 0 },
      owner: -1,
      lastTouch: -1,
      receiver: -1,
      passFrom: -1,
      noPickup: players.map(() => 0),
      z: 0,
      vz: 0,
      touch: 0,
      setPiece: null,
      setPieceDirect: true,
      kickedBy: -1,
      inHands: false,
    },
    score: [0, 0],
    phase: 'kickoff',
    phaseTicks: KICKOFF_PAUSE,
    half: 1,
    clock: 0,
    halfTicks: Math.round((o.halfSeconds ?? HALF_SECONDS) * TICK_HZ),
    kickoffTeam: 0,
    humans,
    controlled: [humans[0] ? firstFwd(0) : -1, humans[1] ? firstFwd(1) : -1],
    switchTimer: [0, 0],
    goals: [],
    events: [],
    cards: [],
    stats: [emptyStats(), emptyStats()],
    restart: null,
    referee: { pos: { x: PITCH_W / 2 - 6, y: PITCH_H / 2 + 12 }, vel: { x: 0, y: 0 }, facing: { x: 0, y: -1 } },
    offside: null,
    advantage: null,
    pendingCards: [],
  };
  resetKickoff(s, 0, 'start');
  return s;
}

/** Law 8: everyone in their own half, the opponents outside the centre circle, the taker on the ball. */
function resetKickoff(s: MatchState, team: 0 | 1, reason: Restart['reason']): void {
  const r: Restart = { kind: 'kickoff', team, spot: { x: PITCH_W / 2, y: PITCH_H / 2 }, taker: -1, stage: 'ready', ticks: 0, direct: true, reason, wait: 0 };
  s.restart = r;
  const taker = chooseTaker(s, r);
  r.taker = taker;
  const partner = s.players.find((p) => p.team === team && !p.sentOff && p.i !== taker && p.role === 'FWD') ?? s.players.find((p) => p.team === team && !p.sentOff && p.i !== taker && p.role === 'MID');
  for (const p of s.players) {
    if (p.sentOff) continue;
    const slot = slotOf(s, p);
    let nx = Math.min(slot.x * 0.85, 0.44);
    let ny = slot.y;
    if (p.role === 'GK') nx = 0.02;
    if (p.i === taker) {
      nx = 0.5 - 1.2 / PITCH_W;
      ny = 0.5;
    } else if (partner && p.i === partner.i) {
      nx = 0.5 - 1.5 / PITCH_W;
      ny = 0.5 + 3 / PITCH_H;
    }
    p.pos = fromTeam(p.team, nx, ny);
    if (p.team !== team) {
      // Outside the centre circle.
      const c = { x: PITCH_W / 2, y: PITCH_H / 2 };
      const d = sub(p.pos, c);
      const l = len(d);
      if (l < CENTRE_R + 0.5) p.pos = add(c, scale(l > 1e-6 ? scale(d, 1 / l) : { x: -attackDir(p.team), y: 0 }, CENTRE_R + 0.5));
    }
    p.vel = { x: 0, y: 0 };
    p.facing = { x: attackDir(p.team), y: 0 };
    p.stun = 0;
    p.tackleCd = 0;
    p.kickCd = 0;
    p.holdTicks = 0;
    p.sprinting = false;
  }
  const b = s.ball;
  b.pos = { x: PITCH_W / 2, y: PITCH_H / 2 };
  b.vel = { x: 0, y: 0 };
  b.owner = taker;
  b.lastTouch = b.owner;
  b.receiver = -1;
  b.passFrom = -1;
  b.noPickup.fill(0);
  b.z = 0;
  b.vz = 0;
  b.touch = 0;
  b.setPiece = null;
  b.kickedBy = -1;
  b.inHands = false;
  s.offside = null;
  s.advantage = null;
  s.kickoffTeam = team;
  s.phase = 'kickoff';
  s.phaseTicks = KICKOFF_PAUSE;
  if (s.humans[team]) s.controlled[team] = b.owner;
  fixControlled(s);
  pushEvent(s, { kind: 'restart', ...eventBase(s, team, taker), restart: 'kickoff', spot: { ...r.spot }, direct: true, reason });
}

// ---------------------------------------------------------------------------
// Actions

function kick(s: MatchState, p: MatchPlayer, target: Vec, speed: number, errSigma: number, receiver: number): void {
  const b = s.ball;
  const dir = rotate(norm(sub(target, b.pos)), gauss(s.rng) * errSigma);
  b.vel = scale(dir, speed);
  b.owner = -1;
  b.lastTouch = p.i;
  b.kickedBy = p.i;
  b.inHands = false;
  b.receiver = receiver;
  // Long enough that a pass played back across the kicker's own body gets past him.
  b.noPickup[p.i] = 22;
  b.touch = 0;
  b.z = 0;
  b.vz = 0;
  b.setPiece = null;
  p.kickCd = 18;
  // Law 11: offside positions are judged now.
  noteBallPlayed(s, p);
}

/** Severity of a foul from how the challenge went in: 0..1 mapped to careless / reckless / excessive. */
function severityOf(score: number): FoulSeverity {
  return score < 0.72 ? 'careless' : score < 0.97 ? 'reckless' : 'excessive';
}

/** Careless fouls are more likely from poor defenders and sloppy sides; a human's challenges are judged the same. */
function care(s: MatchState, p: MatchPlayer): number {
  return 0.5 * p.attrs.defending + 0.5 * clamp(s.teams[p.team].aiSkill, 0, 1);
}

function applyAction(s: MatchState, p: MatchPlayer, intent: Intent): void {
  const a = intent.action;
  if (!a || p.stun > 0 || p.sentOff) return;
  const b = s.ball;
  const team = p.team;

  if (a.kind === 'pass' && b.owner === p.i) {
    const d = dist(b.pos, a.target);
    const err = (0.14 - 0.115 * p.attrs.passing) * (isHumanControlled(s, p) ? HUMAN_AIM : 1);
    kick(s, p, a.target, a.speed ?? passSpeed(d, p.attrs.passing) * (a.through ? 1.05 : 1), err, a.receiver);
    b.passFrom = p.i;
    return;
  }
  if ((a.kind === 'chip' || a.kind === 'loft') && b.owner === p.i) {
    const loft = a.kind === 'loft';
    const plan = loft ? loftPlan(b.pos, a.target, a.power) : chipPlan(b.pos, a.target, a.power);
    const err = loft
      ? (0.015 + 0.04 * a.power * (1.3 - p.attrs.passing)) * (isHumanControlled(s, p) ? HUMAN_AIM : 1)
      : 0.03 + 0.09 * a.power * a.power * (1.3 - p.attrs.shooting);
    kick(s, p, plan.landing, plan.speed, err, -1);
    b.z = CHIP_Z0;
    b.vz = plan.vz;
    b.passFrom = -1;
    if (blockCross(s, p)) return;
    const goalX = oppGoal(team).x;
    const gap = goalX - p.pos.x;
    const carries = Math.abs(plan.landing.x - p.pos.x) > Math.abs(gap) * 0.8;
    if (Math.sign(gap) === Math.sign(b.vel.x) && Math.abs(gap) < 30 && carries) {
      s.stats[team].shots++;
      const t = gap / b.vel.x;
      if (inGoalMouth(b.pos.y + b.vel.y * t)) s.stats[team].onTarget++;
    }
    return;
  }
  if (a.kind === 'shoot' && b.owner === p.i) {
    const power = a.power;
    const speed = (13 + 17 * power) * (0.8 + 0.3 * p.attrs.shooting);
    let err = 0.02 + 0.12 * power * power * (1.3 - p.attrs.shooting);
    if (s.restart?.kind === 'penalty') err *= 0.45; // a dead ball from 11 m: no one closing you down
    kick(s, p, a.target, speed, err, -1);
    if (a.lift && a.lift > 0) {
      b.z = 0.05;
      b.vz = a.lift;
    }
    b.passFrom = -1;
    const goalX = oppGoal(team).x;
    const shooting = Math.sign(goalX - b.pos.x) === Math.sign(b.vel.x) && Math.abs(goalX - b.pos.x) < 32;
    if (shooting) {
      s.stats[team].shots++;
      const t = (goalX - b.pos.x) / b.vel.x;
      if (inGoalMouth(b.pos.y + b.vel.y * t)) s.stats[team].onTarget++;
    }
    return;
  }
  if (a.kind === 'tackle' && p.tackleCd === 0 && b.owner !== p.i && s.phase === 'play') {
    // A slide is a committed lunge: it reaches further (and has to be roughly toward the carrier),
    // is a little less sure, and leaves the tackler on the floor for longer either way.
    const slide = !!a.slide;
    p.tackleCd = slide ? 70 : 36;
    const before = len(p.vel);
    const lunge = norm(sub(a.target, p.pos));
    p.vel = add(p.vel, scale(lunge, slide ? 13 : 3));
    const owner = b.owner >= 0 ? s.players[b.owner] : null;
    const reach = slide ? 3 : 1.7;
    const onLine = !slide || !owner || dot(lunge, norm(sub(owner.pos, p.pos))) > 0.4;
    if (!owner || owner.team === team || dist(owner.pos, p.pos) > reach || !onLine || b.inHands) {
      // A late one: the man has just released the ball and is right there.
      if (!owner) {
        const victim = s.players.find((q) => q.team !== team && !q.sentOff && q.kickCd > 9 && b.lastTouch === q.i && dist(q.pos, p.pos) < 1.4);
        if (victim && next(s.rng) < 0.5 * (1.3 - care(s, p))) {
          const sev = severityOf(0.42 + 0.3 * clamp((before - 4) / 4, 0, 1) + 0.25 * next(s.rng));
          const kept = b.receiver >= 0 && s.players[b.receiver].team === victim.team;
          if (judgeFoul(s, { offender: p, victim, severity: sev, attempt: false, keptBall: kept })) return;
        }
      }
      p.stun = slide ? 30 : 10;
      return;
    }
    // Coming through the back of the man: rarely gets the ball, often fouls. A slide is riskier still.
    const fromBehind = dot(norm(sub(owner.pos, p.pos)), owner.facing) > 0.5;
    let pWin = clamp(0.35 + 0.7 * p.attrs.defending - 0.5 * owner.attrs.dribbling - (slide ? 0.08 : 0), 0.1, 0.88);
    if (fromBehind) pWin *= 0.8;
    if (owner.role === 'GK' && inOwnBox(owner.team, owner.pos)) pWin *= 0.25;
    const won = next(s.rng) < pWin;
    const fast = slide ? 1 : clamp((before - 6.5) / 2.5, 0, 1);
    let pFoul = won ? (fromBehind ? 0.2 : 0.025) : 0.2 + (fromBehind ? 0.3 : 0) + 0.12 * fast;
    pFoul *= 2.05 - 0.9 * care(s, p);
    // A booked CPU player goes in more carefully.
    if (p.yellow > 0 && !isHumanControlled(s, p)) pFoul *= 0.45;
    if (next(s.rng) < pFoul) {
      const sev = severityOf((fromBehind ? 0.3 : 0) + 0.25 * fast + (won ? 0 : 0.1) + 0.32 * next(s.rng) + 0.15 * (1 - p.attrs.defending));
      if (judgeFoul(s, { offender: p, victim: owner, severity: sev, attempt: true, keptBall: !won })) return;
    }
    if (won) {
      b.owner = -1;
      b.inHands = false;
      b.vel = add(scale(norm(sub(b.pos, p.pos)), 3.5), scale(p.vel, 0.3));
      b.lastTouch = p.i;
      b.kickedBy = -1;
      b.receiver = -1;
      b.touch = 0;
      b.noPickup[owner.i] = 24;
      owner.stun = 18;
      if (slide) p.stun = 14;
      s.stats[team].tackles++;
      s.offside = null;
    } else {
      p.stun = slide ? 40 : 26;
      p.tackleCd = slide ? 90 : 50;
    }
  }
}

/**
 * A cross from the flank in the final third can be charged down by a
 * defender right in front of the crosser: it comes off him and usually goes
 * behind for a corner. Returns true if it was blocked.
 */
function blockCross(s: MatchState, p: MatchPlayer): boolean {
  if (s.restart || teamX(p.team, p.pos.x) < 0.68 || Math.abs(p.pos.y - PITCH_H / 2) < GOAL_W) return false;
  const b = s.ball;
  const dir = norm(b.vel);
  for (const o of s.players) {
    if (o.team === p.team || o.sentOff || o.stun > 0 || o.role === 'GK') continue;
    const to = sub(o.pos, p.pos);
    const d = len(to);
    if (d > 2.2 || dot(to, dir) < d * 0.5) continue;
    if (next(s.rng) > 0.3 + 0.25 * o.attrs.defending) return false;
    const side = p.pos.y < PITCH_H / 2 ? -1 : 1;
    b.vel = { x: attackDir(p.team) * range(s.rng, 3, 9), y: side * range(s.rng, 1, 6) };
    b.vz = range(s.rng, 1, 4);
    b.z = 0.8;
    b.lastTouch = o.i;
    b.kickedBy = -1;
    b.noPickup[o.i] = 12;
    return true;
  }
  return false;
}

/** The taker plays a restart (a human's pass/chip/shot Action, or the CPU's restartAction). */
function takeRestart(s: MatchState, p: MatchPlayer, action: Action): void {
  const r = s.restart!;
  const b = s.ball;
  b.pos = { ...r.spot };
  b.owner = p.i;
  b.z = 0;
  b.vz = 0;
  b.touch = 0;
  b.noPickup.fill(0);
  p.stun = 0;
  if (r.kind === 'throwin') {
    // Law 15: from the hands, both feet on or behind the line, into the field.
    const long = action.kind !== 'pass';
    const maxD = long ? 16 + 14 * p.attrs.passing : 22;
    let to = sub(action.target, r.spot);
    const inward = r.spot.y < PITCH_H / 2 ? 1 : -1;
    if (to.y * inward < 0.5) to = { x: to.x, y: inward * Math.max(1.5, Math.abs(to.y)) };
    const d = clamp(len(to), 3, maxD);
    const target = add(r.spot, scale(norm(to), d));
    const T = clamp(0.4 + 0.034 * d, 0.5, 1.4);
    const speed = (d * AIR_DRAG) / (1 - Math.exp(-AIR_DRAG * T));
    kick(s, p, target, speed, 0.03 + 0.05 * (1 - p.attrs.passing), action.kind === 'pass' ? action.receiver : -1);
    b.z = THROW_Z0;
    b.vz = (0.5 * GRAVITY * T * T - THROW_Z0) / T;
    b.passFrom = action.kind === 'pass' ? p.i : -1;
  } else {
    s.phase = 'play'; // applyAction reads the phase for tackles only; the restart is still set so a penalty knows it's a penalty
    applyAction(s, p, { move: { x: 0, y: 0 }, throttle: 0, action });
    if (b.owner === p.i) {
      // Not a kick (a tackle input): ignore, stay ready.
      s.phase = 'restart';
      return;
    }
  }
  s.phase = 'play';
  s.restart = null;
  b.setPiece = r.kind;
  b.setPieceDirect = r.direct;
  b.noPickup[p.i] = 24; // no second touch before someone else plays it
  if (NO_OFFSIDE.has(r.kind)) s.offside = null;
  pushEvent(s, { kind: 'restartTaken', ...eventBase(s, r.team, p.i), restart: r.kind, spot: { ...r.spot } });
  if (r.kind === 'penalty') {
    const gk = goalkeeper(s, r.team === 0 ? 1 : 0);
    const tLine = Math.abs((ownGoal(gk.team).x - b.pos.x) / (b.vel.x || 1e-6));
    const side = penaltyDive(s, gk, b.pos.y + b.vel.y * tLine);
    gk.vel = { x: 0, y: side * (2.2 + 1.6 * gk.attrs.goalkeeping) };
  }
}

// ---------------------------------------------------------------------------
// Physics

function movePlayer(s: MatchState, p: MatchPlayer, intent: Intent): void {
  if (p.sentOff) return;
  const hasBall = s.ball.owner === p.i;
  // The human's player is more responsive than a CPU player: quicker to
  // accelerate and turn, so the ball swings round with the mouse.
  const human = isHumanControlled(s, p);
  if (p.winded && p.energy >= WINDED_RECOVER) p.winded = false;
  else if (!p.winded && p.energy <= WINDED_BELOW) p.winded = true;
  p.sprinting = !!intent.sprint && intent.throttle > 0.5 && p.stun === 0 && !p.winded;

  const energyFactor = 0.82 + 0.18 * p.energy;
  const topSpeed = 5 + 3.4 * p.attrs.pace;
  let maxSpeed = topSpeed * energyFactor;
  if (p.sprinting) maxSpeed *= SPRINT_MULT;
  if (hasBall) maxSpeed *= 0.86 + 0.08 * p.attrs.dribbling;
  if (p.stun > 0) maxSpeed *= 0.15;
  const k = maxSpeed * intent.throttle;
  const dx = intent.move.x * k;
  const dy = intent.move.y * k;
  const accel = (hasBall ? (human ? 26 : 18) : human ? 32 : 24) * (p.sprinting ? 1.15 : 1) * DT;
  const ex = dx - p.vel.x;
  const ey = dy - p.vel.y;
  const dl = Math.sqrt(ex * ex + ey * ey);
  if (dl <= accel) p.vel = { x: dx, y: dy };
  else p.vel = { x: p.vel.x + (ex * accel) / dl, y: p.vel.y + (ey * accel) / dl };
  p.pos = { x: p.pos.x + p.vel.x * DT, y: p.pos.y + p.vel.y * DT };

  const speed = Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y);
  const effort = Math.min(1, speed / topSpeed);
  let e = p.energy - effort * effort * DT * 0.0035 * (1.4 - p.attrs.stamina);
  if (p.sprinting) e -= SPRINT_DRAIN * DT * (1.5 - 0.8 * p.attrs.stamina);
  else if (effort < 0.25) e += 0.04 * DT;
  else if (effort < 0.7) e += 0.02 * DT;
  p.energy = clamp(e, 0.4, 1);

  const steering = human && intent.throttle > 0.15;
  if (speed > 0.3 || steering) {
    const base = hasBall ? 6 + 6 * p.attrs.dribbling : 14;
    const turn = base * (human ? 1.7 : 1) * DT;
    // A human's facing follows where they are steering, not where they have got to.
    const want = steering ? intent.move : scale(p.vel, 1 / speed);
    p.facing = norm(add(p.facing, scale(sub(want, p.facing), Math.min(1, turn))));
  }
  p.pos.x = clamp(p.pos.x, -RUN_OFF, PITCH_W + RUN_OFF);
  p.pos.y = clamp(p.pos.y, -RUN_OFF, PITCH_H + RUN_OFF);
}

function separate(s: MatchState): void {
  const ps = s.players;
  for (let a = 0; a < ps.length; a++) {
    if (ps[a].sentOff) continue;
    for (let b = a + 1; b < ps.length; b++) {
      if (ps[b].sentOff) continue;
      const dx = ps[b].pos.x - ps[a].pos.x;
      const dy = ps[b].pos.y - ps[a].pos.y;
      if (dx > PLAYER_R * 2 || dx < -PLAYER_R * 2 || dy > PLAYER_R * 2 || dy < -PLAYER_R * 2) continue;
      const l = Math.sqrt(dx * dx + dy * dy);
      const overlap = PLAYER_R * 2 - l;
      if (overlap > 0 && l > 1e-6) {
        const k = (overlap / l) * 0.5;
        ps[a].pos = { x: ps[a].pos.x - dx * k, y: ps[a].pos.y - dy * k };
        ps[b].pos = { x: ps[b].pos.x + dx * k, y: ps[b].pos.y + dy * k };
      }
    }
  }
}

function scoreGoal(s: MatchState, team: 0 | 1): void {
  const b = s.ball;
  const last = b.lastTouch >= 0 ? s.players[b.lastTouch] : null;
  const straightFrom = b.setPiece && b.lastTouch >= 0 ? b.setPiece : null;
  const other: 0 | 1 = team === 0 ? 1 : 0;
  if (straightFrom && last) {
    // Laws 13, 15: no goal straight from an indirect free kick or a throw-in;
    // and nobody scores straight into their own goal from a restart.
    if (last.team !== team) {
      awardRestart(s, 'corner', team, b.pos, 'out');
      return;
    }
    if (!b.setPieceDirect) {
      awardRestart(s, 'goalkick', other, b.pos, 'out');
      return;
    }
  }
  s.score[team]++;
  const scorer = last ? (last.team === team ? last.name : `${last.name} (OG)`) : 'Unknown';
  if (s.advantage && s.advantage.team === team) downgradeDogso(s);
  s.advantage = null;
  pushEvent(s, { kind: 'goal', ...eventBase(s, team, last ? last.i : -1), scorer, ownGoal: !!last && last.team !== team, from: straightFrom ?? 'play' });
  flushPendingCards(s);
  s.phase = 'goal';
  s.phaseTicks = GOAL_PAUSE;
  s.restart = null;
  s.offside = null;
  b.owner = -1;
  b.receiver = -1;
  b.inHands = false;
  s.kickoffTeam = other;
}

const POSTS: Vec[] = [
  { x: 0, y: GOAL_TOP },
  { x: 0, y: GOAL_BOTTOM },
  { x: PITCH_W, y: GOAL_TOP },
  { x: PITCH_W, y: GOAL_BOTTOM },
];

/** The goal frame: net on three sides behind the line, and the posts. There are no boards. */
function goalFrame(s: MatchState, prevX: number): void {
  const b = s.ball;
  const p = b.pos;
  const behind = p.x < 0 || p.x > PITCH_W;
  const wasBehind = prevX < 0 || prevX > PITCH_W;
  if (behind && inGoalMouth(p.y) && (wasBehind || b.z <= GOAL_BAR_H) && (s.phase === 'goal' || !wasBehind || Math.abs(p.x - prevX) < 1)) {
    // Inside the goal frame: net on three sides.
    const backX = p.x < 0 ? -GOAL_DEPTH : PITCH_W + GOAL_DEPTH;
    if ((p.x < 0 && p.x < backX + BALL_R) || (p.x > PITCH_W && p.x > backX - BALL_R)) {
      p.x = p.x < 0 ? backX + BALL_R : backX - BALL_R;
      b.vel.x *= -0.2;
    }
    if (wasBehind) {
      if (p.y < GOAL_TOP + BALL_R) { p.y = GOAL_TOP + BALL_R; b.vel.y *= -0.2; }
      if (p.y > GOAL_BOTTOM - BALL_R) { p.y = GOAL_BOTTOM - BALL_R; b.vel.y *= -0.2; }
    }
    if (b.z > GOAL_BAR_H - BALL_R) { b.z = GOAL_BAR_H - BALL_R; b.vz = Math.min(0, b.vz); }
    return;
  }
  if (b.z > GOAL_BAR_H + 0.2) return;
  for (const post of POSTS) {
    const d = sub(p, post);
    const l = len(d);
    if (l < BALL_R + 0.06 && l > 1e-6) {
      const n = scale(d, 1 / l);
      b.pos = add(post, scale(n, BALL_R + 0.06));
      const vn = b.vel.x * n.x + b.vel.y * n.y;
      if (vn < 0) b.vel = sub(b.vel, scale(n, 1.7 * vn));
    }
  }
}

/** Has the whole ball crossed a line? Then it is a goal or out of play. Returns true if play stopped. */
function checkLines(s: MatchState): boolean {
  const b = s.ball;
  const p = b.pos;
  if (p.x < -BALL_R || p.x > PITCH_W + BALL_R) {
    if (inGoalMouth(p.y) && b.z < GOAL_BAR_H - BALL_R) scoreGoal(s, p.x < 0 ? 1 : 0);
    else ballOut(s, { ...p });
    return true;
  }
  if (p.y < -BALL_R || p.y > PITCH_H + BALL_R) {
    ballOut(s, { ...p });
    return true;
  }
  return false;
}

function updateBall(s: MatchState, live: boolean): void {
  const b = s.ball;
  for (let i = 0; i < b.noPickup.length; i++) if (b.noPickup[i] > 0) b.noPickup[i]--;

  if (b.owner >= 0) {
    const o = s.players[b.owner];
    // A keeper holding the ball always faces upfield, so it can't drift over the line.
    if (o.role === 'GK' && inOwnBox(o.team, o.pos)) o.facing = { x: attackDir(o.team), y: 0 };
    const spot = add(o.pos, scale(o.facing, PLAYER_R + BALL_R + 0.23));
    b.z = 0;
    b.vz = 0;
    if (b.touch > 0) {
      // First touch: the ball keeps some of its momentum and settles into the
      // feet over a few ticks instead of snapping to them.
      b.vel = add(b.vel, scale(sub(o.vel, b.vel), 0.22));
      b.pos = add(b.pos, scale(b.vel, DT));
      b.pos = add(b.pos, scale(sub(spot, b.pos), 0.18 + 0.32 * (1 - b.touch / 14)));
      b.touch--;
    } else {
      b.pos = add(b.pos, scale(sub(spot, b.pos), 0.5));
      b.vel = { ...o.vel };
    }
    if (b.inHands) b.z = 1.1;
    if (live) checkLines(s);
    return;
  }
  const speed = len(b.vel);
  if (b.z > 0 || b.vz > 0) {
    // In the air: gravity, light drag, damped bounce. z never goes below 0.
    b.vz -= GRAVITY * DT;
    b.z += b.vz * DT;
    b.vel = scale(b.vel, 1 - AIR_DRAG * DT);
    if (b.z <= 0) {
      b.z = 0;
      if (b.vz < -1.5) {
        b.vz = -b.vz * BOUNCE_DAMP;
        b.vel = scale(b.vel, 0.82);
      } else b.vz = 0;
    }
  } else if (speed > 0) {
    const ns = Math.max(0, speed - rollDecel(speed) * DT);
    b.vel = scale(b.vel, ns / speed);
  }
  const prevX = b.pos.x;
  b.pos = add(b.pos, scale(b.vel, DT));
  goalFrame(s, prevX);
  if (!live) return;
  if (checkLines(s)) return;
  pickup(s);
}

/** Law 12 (handling): a keeper may not pick up a ball a teammate deliberately kicked or threw to him. */
function keeperHands(s: MatchState, p: MatchPlayer): boolean {
  if (p.role !== 'GK' || !inOwnBox(p.team, p.pos)) return false;
  const k = s.ball.kickedBy;
  return !(k >= 0 && k !== p.i && s.players[k].team === p.team);
}

function pickup(s: MatchState): void {
  const b = s.ball;
  const speed = len(b.vel) + Math.abs(b.vz) * 0.5;
  let best: MatchPlayer | null = null;
  let bestD = Infinity;
  for (const p of s.players) {
    if (p.stun > 0 || b.noPickup[p.i] > 0 || p.sentOff) continue;
    const hands = keeperHands(s, p);
    if (b.z > (hands ? KEEPER_REACH_Z : REACH_Z)) continue; // too high to take
    // A fast ball gets past a defender who has to react to it; the man it was meant for reaches out for it.
    const reach = hands ? 1.0 + 0.7 * p.attrs.goalkeeping - clamp((speed - 12) * 0.025, 0, 0.45) : b.receiver === p.i ? PLAYER_R + 0.58 : clamp(1.25 - 0.025 * speed, 0.7, 1.15);
    const dx = p.pos.x - b.pos.x;
    const dy = p.pos.y - b.pos.y;
    if (dx > reach || dx < -reach || dy > reach || dy < -reach) continue;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < reach && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  if (!best) {
    header(s);
    return;
  }
  const p = best;
  const hands = keeperHands(s, p);
  const control = hands ? 5 + 12 * p.attrs.goalkeeping : 6 + 11 * p.attrs.dribbling + (b.receiver === p.i ? 5 : 0);
  const takes = speed <= control;
  if (offsideOnTouch(s, p, takes)) return;

  if (takes) {
    const from = b.passFrom >= 0 ? s.players[b.passFrom] : null;
    if (from && from.team === p.team && from.i !== p.i) s.stats[p.team].passes++;
    b.owner = p.i;
    b.lastTouch = p.i;
    b.receiver = -1;
    b.passFrom = -1;
    b.kickedBy = -1;
    b.setPiece = null;
    b.inHands = hands;
    b.touch = clamp(Math.round(speed * 1.2), 4, 14);
    b.vz = 0;
    p.holdTicks = 0;
    p.aiTimer = Math.max(p.aiTimer, 4);
    return;
  }
  // Too hot to control: parry or deflect.
  if (b.setPiece && b.lastTouch !== p.i) b.setPiece = null;
  b.lastTouch = p.i;
  b.receiver = -1;
  b.touch = 0;
  b.kickedBy = -1;
  b.noPickup[p.i] = 12;
  if (hands) {
    const away = attackDir(p.team);
    const goingIn = b.vel.x * away < 0;
    if (goingIn && next(s.rng) < 0.75) {
      // Tipped round the post or over the bar: out for a corner, usually.
      const side = b.pos.y < PITCH_H / 2 ? -1 : 1;
      b.vel = { x: b.vel.x * 0.3, y: side * range(s.rng, 4, 8) };
      b.vz = range(s.rng, 0.5, 3);
    } else {
      b.vel = { x: Math.abs(b.vel.x) * 0.35 * away, y: b.vel.y * 0.3 + range(s.rng, -5, 5) };
      b.vz = Math.abs(b.vz) * 0.3;
    }
  } else {
    // A shot or cross blocked near goal often spins away behind for a corner.
    const towardOwnGoal = b.vel.x * attackDir(p.team) < -7 && teamX(p.team, p.pos.x) < 0.35;
    if (towardOwnGoal && next(s.rng) < 0.7) {
      const side = b.pos.y < PITCH_H / 2 ? -1 : 1;
      b.vel = { x: b.vel.x * range(s.rng, 0.35, 0.6), y: b.vel.y * 0.3 + side * range(s.rng, 3, 9) };
      b.vz = range(s.rng, 0, 3);
    } else b.vel = rotate(scale(b.vel, 0.5), range(s.rng, -0.7, 0.7));
  }
}

/**
 * A dropping ball between REACH_Z and HEAD_Z can be headed: by an opponent of
 * whoever played it (a clearance), or by an attacker in the opponents' box (at goal).
 * Teammates elsewhere let it drop to feet.
 */
function header(s: MatchState): void {
  const b = s.ball;
  if (b.z <= REACH_Z || b.z > HEAD_Z || b.vz > 0) return;
  const lastTeam = b.lastTouch >= 0 ? s.players[b.lastTouch].team : -1;
  let best: MatchPlayer | null = null;
  let bestD = Infinity;
  for (const p of s.players) {
    if (p.stun > 0 || b.noPickup[p.i] > 0 || p.sentOff || p.role === 'GK') continue;
    const attacking = p.team === lastTeam && inOwnBox(p.team === 0 ? 1 : 0, p.pos);
    if (p.team === lastTeam && !attacking) continue;
    const d = dist(p.pos, b.pos);
    if (d < PLAYER_R + 0.8 && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  if (!best) return;
  const p = best;
  // Not every jump connects.
  if (next(s.rng) > 0.62 + 0.25 * (p.role === 'DEF' ? p.attrs.defending : p.attrs.shooting)) {
    b.noPickup[p.i] = 30;
    return;
  }
  const atGoal = p.team === lastTeam;
  if (offsideOnTouch(s, p, !atGoal)) return;
  if (b.setPiece && b.lastTouch !== p.i) b.setPiece = null;
  b.lastTouch = p.i;
  b.kickedBy = p.i;
  b.receiver = -1;
  b.passFrom = -1;
  b.touch = 0;
  b.noPickup[p.i] = 16;
  if (atGoal) {
    const goal = oppGoal(p.team);
    const gk = goalkeeper(s, p.team === 0 ? 1 : 0);
    const y = gk.pos.y > PITCH_H / 2 ? GOAL_TOP + 0.9 : GOAL_BOTTOM - 0.9;
    const dir = rotate(norm(sub({ x: goal.x, y }, b.pos)), gauss(s.rng) * (0.08 + 0.16 * (1 - p.attrs.shooting)));
    const sp = 10 + 6 * p.attrs.shooting;
    b.vel = scale(dir, sp);
    const t = dist(b.pos, { x: goal.x, y }) / sp;
    // Down toward the line, bouncing in front of the keeper or under the bar.
    b.vz = clamp((0.6 - b.z) / Math.max(t, 0.2) + 0.5 * GRAVITY * t, -6, 3);
    s.stats[p.team].shots++;
    const tl = (goal.x - b.pos.x) / (b.vel.x || 1e-6);
    if (tl > 0 && inGoalMouth(b.pos.y + b.vel.y * tl)) s.stats[p.team].onTarget++;
  } else {
    // Head it away: upfield and wide of the goal. Under pressure near goal a glancing header can go behind.
    const nearGoal = inOwnBox(p.team, p.pos);
    if (nearGoal && next(s.rng) < 0.42 - 0.2 * p.attrs.defending) {
      const side = b.pos.y < PITCH_H / 2 ? -1 : 1;
      b.vel = { x: -attackDir(p.team) * range(s.rng, 7, 12), y: side * range(s.rng, 4, 9) };
      b.vz = 2 + 2 * next(s.rng);
    } else {
      const away = norm(add({ x: attackDir(p.team) * 1.2, y: 0 }, scale(norm(sub(b.pos, ownGoal(p.team))), 0.8)));
      b.vel = scale(rotate(away, range(s.rng, -0.5, 0.5)), 11 + 4 * p.attrs.defending);
      b.vz = 4 + 2 * next(s.rng);
    }
  }
}

// ---------------------------------------------------------------------------

/** True for the player a human is steering right now. */
export function isHumanControlled(s: MatchState, p: MatchPlayer): boolean {
  return s.humans[p.team] && s.controlled[p.team] === p.i;
}

const NO_INPUT: HumanInput = {};

/**
 * Per-team inputs from either form step() accepts. A single HumanInput is the
 * one-human shorthand: it goes to team 0, or to team 1 when only team 1 has a
 * human. A pair is [home input, away input]; a CPU team's entry is ignored.
 */
export function teamInputs(s: MatchState, input: HumanInput | TeamInputs | undefined): TeamInputs {
  if (Array.isArray(input)) return [input[0] ?? NO_INPUT, input[1] ?? NO_INPUT];
  const one = input ?? NO_INPUT;
  return !s.humans[0] && s.humans[1] ? [NO_INPUT, one] : [one, NO_INPUT];
}

const IDLE_INTENT: Intent = { move: { x: 0, y: 0 }, throttle: 0 };
const isKick = (a: Action | undefined): a is Action => !!a && (a.kind === 'pass' || a.kind === 'chip' || a.kind === 'loft' || a.kind === 'shoot');

function setupLength(r: Restart): number {
  switch (r.kind) {
    case 'throwin':
      return RESTART_SETUP_MIN;
    case 'goalkick':
      return 50;
    case 'corner':
      return 85;
    case 'penalty':
      return 95;
    case 'freekick':
      return dist(r.spot, oppGoal(r.team)) < 32 ? 85 : 45;
    default:
      return RESTART_SETUP_MIN;
  }
}

/** The ball is dead and has stopped: put it on the spot, pick the taker. */
function beginSetup(s: MatchState, r: Restart): void {
  r.stage = 'setup';
  r.ticks = 0;
  r.taker = chooseTaker(s, r);
  const b = s.ball;
  b.pos = { ...r.spot };
  b.vel = { x: 0, y: 0 };
  b.z = 0;
  b.vz = 0;
  b.owner = r.taker;
  b.lastTouch = r.taker;
  b.receiver = -1;
  b.inHands = false;
  const t = s.players[r.taker];
  t.stun = 0;
  if (s.humans[r.team] && t.role !== 'GK') s.controlled[r.team] = r.taker;
  // Anyone still on the floor gets up.
  for (const p of s.players) p.stun = Math.min(p.stun, 10);
}

function beginReady(s: MatchState, r: Restart): void {
  r.stage = 'ready';
  r.ticks = 0;
  const t = s.players[r.taker];
  t.pos = takerSpot(r);
  t.vel = { x: 0, y: 0 };
  const face = norm(r.kind === 'throwin' ? { x: 0, y: r.spot.y < PITCH_H / 2 ? 1 : -1 } : sub(oppGoal(r.team), r.spot));
  if (len(face) > 0) t.facing = face;
  const skill = clamp(s.teams[r.team].aiSkill, 0, 1);
  r.wait = r.kind === 'penalty' ? 45 : Math.round(14 + 22 * (1 - skill) + next(s.rng) * 14);
  enforceRestartPositions(s);
  const b = s.ball;
  b.owner = r.taker;
  b.inHands = r.kind === 'throwin';
  b.pos = { ...r.spot };
  b.z = restartBallZ(r);
}

/** One tick of a dead ball. */
function stepRestart(s: MatchState, inputs: TeamInputs): void {
  const r = s.restart!;
  r.ticks++;
  if (r.stage === 'whistle') {
    for (const p of s.players) {
      if (p.sentOff) continue;
      const humanCtl = isHumanControlled(s, p);
      const it = humanCtl ? humanIntent(s, p, inputs[p.team]) : restartIntent(s, p);
      movePlayer(s, p, { move: it.move, throttle: Math.min(it.throttle, 0.7) });
    }
    separate(s);
    updateBall(s, false);
    if (r.ticks >= (r.reason === 'foul' || r.reason === 'offside' ? RESTART_WHISTLE_FOUL : RESTART_WHISTLE)) beginSetup(s, r);
    return;
  }

  const b = s.ball;
  b.owner = r.taker;
  updateControl(s, 0, inputs[0]);
  updateControl(s, 1, inputs[1]);
  fixControlled(s);
  const taker = s.players[r.taker];
  const spot = takerSpot(r);
  let kickAction: Action | null = null;
  for (const p of s.players) {
    if (p.sentOff) continue;
    const humanCtl = isHumanControlled(s, p);
    if (p === taker) {
      if (r.stage === 'setup') {
        const d = sub(spot, p.pos);
        const l = len(d);
        movePlayer(s, p, l < 0.2 ? IDLE_INTENT : { move: norm(d), throttle: Math.min(1, l / 1.5), sprint: l > 12 });
      } else {
        // Over the ball (or holding it): stays put until it is played.
        if (humanCtl && r.ticks < RESTART_HUMAN_WAIT) {
          const it = humanIntent(s, p, inputs[p.team]);
          if (isKick(it.action)) kickAction = it.action;
          if (it.throttle > 0.15) p.facing = norm(add(scale(p.facing, 0.8), scale(it.move, 0.2)));
        } else if (r.ticks >= r.wait) kickAction = restartAction(s, p);
        p.pos = { ...spot };
        p.vel = { x: 0, y: 0 };
      }
      continue;
    }
    const it = humanCtl ? humanIntent(s, p, inputs[p.team]) : restartIntent(s, p);
    movePlayer(s, p, { move: it.move, throttle: it.throttle, sprint: it.sprint });
  }
  separate(s);
  enforceRestartPositions(s);
  b.pos = { ...r.spot };
  b.vel = { x: 0, y: 0 };
  b.z = restartBallZ(r);

  if (r.stage === 'setup') {
    const there = dist(taker.pos, spot) < 0.6;
    if ((there && r.ticks >= setupLength(r)) || r.ticks >= RESTART_SETUP_MAX) beginReady(s, r);
    return;
  }
  if (kickAction) takeRestart(s, taker, kickAction);
}

/** The clock runs through dead balls, as in a real match; half-time waits for a penalty to be taken. */
function runClock(s: MatchState): void {
  s.clock++;
  if (s.phase !== 'play' && s.phase !== 'restart') return;
  if (s.clock < s.halfTicks * s.half) return;
  const penaltyPending = s.restart?.kind === 'penalty' || (s.phase === 'play' && s.ball.setPiece === 'penalty' && s.ball.owner < 0);
  if (penaltyPending) return;
  s.restart = null;
  s.advantage = null;
  flushPendingCards(s);
  s.ball.owner = -1;
  s.ball.inHands = false;
  if (s.half === 1) {
    s.phase = 'halftime';
    s.phaseTicks = HALFTIME_PAUSE;
    pushEvent(s, { kind: 'halftime', ...eventBase(s, 0, -1) });
  } else {
    s.phase = 'fulltime';
    pushEvent(s, { kind: 'fulltime', ...eventBase(s, 0, -1) });
  }
}

/**
 * Advance one tick. `input` is either one HumanInput (one human, see
 * teamInputs) or a [home, away] pair when both teams have a human.
 */
export function step(s: MatchState, input?: HumanInput | TeamInputs): void {
  s.tick++;
  for (const p of s.players) {
    if (p.stun > 0) p.stun--;
    if (p.tackleCd > 0) p.tackleCd--;
    if (p.kickCd > 0) p.kickCd--;
  }

  if (s.phase === 'fulltime') return;
  moveReferee(s);
  if (s.phase === 'kickoff') {
    if (--s.phaseTicks <= 0) {
      s.phase = 'play';
      const r = s.restart;
      s.restart = null;
      if (r) pushEvent(s, { kind: 'restartTaken', ...eventBase(s, r.team, r.taker), restart: 'kickoff', spot: { ...r.spot } });
    }
    updateBall(s, false);
    return;
  }
  if (s.phase === 'goal' || s.phase === 'halftime') {
    for (const p of s.players) movePlayer(s, p, { move: { x: 0, y: 0 }, throttle: 0 });
    updateBall(s, false);
    if (--s.phaseTicks <= 0) {
      if (s.phase === 'halftime') {
        s.half = 2;
        resetKickoff(s, 1, 'half');
      } else resetKickoff(s, s.kickoffTeam, 'goal');
    }
    return;
  }

  const inputs = teamInputs(s, input);
  if (s.phase === 'restart') {
    stepRestart(s, inputs);
    runClock(s);
    return;
  }

  updateControl(s, 0, inputs[0]);
  updateControl(s, 1, inputs[1]);
  fixControlled(s);
  const intents = s.players.map((p) => (p.sentOff ? IDLE_INTENT : isHumanControlled(s, p) ? humanIntent(s, p, inputs[p.team]) : aiIntent(s, p)));
  for (let i = 0; i < s.players.length && s.phase === 'play'; i++) applyAction(s, s.players[i], intents[i]);
  s.players.forEach((p, i) => movePlayer(s, p, intents[i]));
  separate(s);
  updateBall(s, s.phase === 'play');
  if (s.phase === 'play') tickAdvantage(s);

  if (s.ball.owner >= 0) s.stats[s.players[s.ball.owner].team].possessionTicks++;
  runClock(s);
}

/** Run a whole match with no human, as fast as possible. Used for tests, balance and quick-sim. */
export function simulate(o: Omit<MatchOptions, 'humanTeam' | 'humans'>): MatchState {
  const s = createMatch({ ...o, humans: [false, false] });
  while (s.phase !== 'fulltime') step(s);
  return s;
}

/** Compact fingerprint of the state, for determinism checks. */
export function fingerprint(s: MatchState): string {
  const r = (n: number) => Math.round(n * 1000);
  return [
    s.tick,
    s.score.join(':'),
    s.phase,
    s.restart ? `${s.restart.kind}${s.restart.team}${s.restart.stage}` : '-',
    s.events.length,
    r(s.ball.pos.x),
    r(s.ball.pos.y),
    r(s.ball.z),
    r(s.referee.pos.x),
    r(s.referee.pos.y),
    ...s.players.map((p) => `${r(p.pos.x)},${r(p.pos.y)},${r(p.energy)}${p.yellow ? `y${p.yellow}` : ''}${p.sentOff ? 'R' : ''}`),
  ].join('|');
}

export function possessionShare(s: MatchState): [number, number] {
  const a = s.stats[0].possessionTicks;
  const b = s.stats[1].possessionTicks;
  const t = a + b || 1;
  return [Math.round((a / t) * 100), Math.round((b / t) * 100)];
}
