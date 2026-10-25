// Fixed-timestep, seeded match simulation. step() is a pure function of
// (state, human inputs): no DOM, no clocks, no Math.random. That property is
// what makes server authority, replays and lockstep/rollback netcode possible.
//
// Either team, or both, can have a human. Each human steers one player of their
// team (MatchState.controlled[team]); the rest of that team is CPU-driven.
//
// Eleven-a-side under the Laws of the Game: the ball goes out of play, and
// restarts, offside, fouls and cards are applied by rules.ts. Phases:
//   kickoff   players frozen in their halves, then a 'restart' at stage 'ready': the
//             taker kicks it like any other restart (Law 8)
//   play      live ball
//   restart   dead ball: rules.ts Restart (whistle -> setup -> ready -> taken)
//   goal, halftime, fulltime

import { aiIntent, passSpeed, penaltyDive, restartAction, restartIntent } from './ai.ts';
import {
  AIR_DRAG,
  BALL_R,
  BOUNCE_DAMP,
  BOUNCE_KEEP,
  CHIP_Z0,
  CENTRE_R,
  DT,
  formationOf,
  GOAL_BAR_H,
  GRAVITY,
  HEAD_Z,
  KEEPER_REACH_Z,
  LONG_SHOT_ERR,
  MENTALITY_IDS,
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
  RETREAT,
  SLIDE_TRAVEL,
  STAND_REACH,
  TEAM_SIZE,
  TICK_HZ,
} from './constants.ts';
import { attackDir, fromTeam, goalkeeper, inGoalMouth, inOwnBox, oppGoal, ownGoal, slotOf, teamAtEnd, teamX } from './field.ts';
import { humanIntent, KEEPER_HOLD_TICKS, updateControl } from './human.ts';
import { assistReceiver, chipPlan, loftPlan, passTo, passToPoint, puntPlan, rollTravel, setPieceStrike, SHOT_Z0, shotSpeed, type StrikePlan } from './kicks.ts';
import {
  addedMinutes,
  awardRestart,
  ballOut,
  barredSecondTouch,
  chooseTaker,
  clearWall,
  downgradeDogso,
  enforceRestartPositions,
  eventBase,
  fixControlled,
  flushPendingCards,
  goalBound,
  handsBarred,
  judgeFoul,
  matchMinute,
  matchSeconds,
  moveReferee,
  NO_OFFSIDE,
  noteBallPlayed,
  offsideOnTouch,
  offsidePlayed,
  pushEvent,
  restartBallZ,
  secondTouch,
  takerSpot,
  tickAdvantage,
} from './rules.ts';
import { gauss, makeRng, next, range } from './rng.ts';
import type { Action, FoulSeverity, HumanInput, Intent, MatchPlayer, MatchState, Restart, TeamInputs, TeamSetup, TeamStats } from './types.ts';
import { add, clamp, dist, distToSegment, dot, len, norm, rotate, scale, sub, type Vec } from './vec.ts';

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
  passAttempts: 0,
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
        facing: { x: attackDir({ half: 1 }, team as 0 | 1), y: 0 },
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
    // Copies: quick tactics change a side's mentality mid-match without touching the caller's setup.
    teams: [{ ...o.home }, { ...o.away }],
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
    poss: -1,
    ctlHold: [false, false],
    queued: [null, null],
  };
  resetKickoff(s, 0, 'start');
  return s;
}

/** Law 8: everyone in their own half, the opponents outside the centre circle, the taker on the ball. */
function resetKickoff(s: MatchState, team: 0 | 1, reason: Restart['reason']): void {
  const r: Restart = { kind: 'kickoff', team, spot: { x: PITCH_W / 2, y: PITCH_H / 2 }, taker: -1, stage: 'ready', ticks: 0, direct: true, reason, wait: 0 };
  s.restart = r;
  clearWall(s);
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
      nx = teamX(s, team, takerSpot(s, r).x);
      ny = 0.5;
    } else if (partner && p.i === partner.i) {
      nx = 0.5 - 1.5 / PITCH_W;
      ny = 0.5 + 3 / PITCH_H;
    }
    p.pos = fromTeam(s, p.team, nx, ny);
    if (p.team !== team) {
      // Outside the centre circle.
      const c = { x: PITCH_W / 2, y: PITCH_H / 2 };
      const d = sub(p.pos, c);
      const l = len(d);
      if (l < CENTRE_R + 0.5) p.pos = add(c, scale(l > 1e-6 ? scale(d, 1 / l) : { x: -attackDir(s, p.team), y: 0 }, CENTRE_R + 0.5));
    }
    p.vel = { x: 0, y: 0 };
    p.facing = { x: attackDir(s, p.team), y: 0 };
    p.stun = 0;
    p.slide = null;
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
  b.handTicks = 0;
  b.restartBy = -1;
  b.noHands = -1;
  for (const p of s.players) p.dive = null;
  s.offside = null;
  s.advantage = null;
  s.poss = team;
  if (s.queued) s.queued = [null, null];
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
  // Law 12: an opponent may not prevent a keeper releasing the ball. Those standing close
  // can't touch his throw, roll or punt until it is past them.
  if (b.inHands && b.owner === p.i) {
    for (const o of s.players) if (o.team !== p.team && dist(o.pos, p.pos) < RELEASE_CLEAR) b.noPickup[o.i] = Math.max(b.noPickup[o.i], RELEASE_CLEAR_TICKS);
    // Law 12: once he has released it he may not handle it again until someone else touches it.
    if (p.role === 'GK' && !s.restart) b.noHands = p.i;
  }
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
  b.whiff = -1;
  b.spin = null;
  b.redirectedAt = s.tick;
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
    s.stats[team].passAttempts++;
    return;
  }
  if ((a.kind === 'chip' || a.kind === 'loft' || a.kind === 'punt') && b.owner === p.i) {
    const human = isHumanControlled(s, p);
    const plan = a.kind === 'loft' ? loftPlan(b.pos, a.target, a.power) : a.kind === 'punt' ? puntPlan(b.pos, a.target, a.power) : chipPlan(b.pos, a.target, a.power);
    const err =
      a.kind === 'chip'
        ? 0.03 + 0.09 * a.power * a.power * (1.3 - p.attrs.shooting)
        : (0.015 + 0.04 * a.power * (1.3 - p.attrs.passing)) * (human ? HUMAN_AIM : 1);
    // A lofted pass is meant for the team-mate nearest where it comes down (the same assist as
    // a click), so he goes to meet it and takes it cleanly. A punt is for whoever wins it.
    const receiver = a.kind === 'punt' ? -1 : assistReceiver(s, p, b.pos, plan.landing);
    kick(s, p, plan.landing, plan.speed, err, receiver);
    b.z = CHIP_Z0;
    b.vz = plan.vz;
    if (a.kind !== 'punt' && blockCross(s, p)) return;
    // A lofted ball or a long kick that a teammate takes is a completed pass too; a chip
    // or loft at goal is a shot, not a pass.
    if (a.kind === 'punt' || !countShot(s, team)) {
      b.passFrom = p.i;
      s.stats[team].passAttempts++;
    } else b.receiver = -1;
    return;
  }
  if (a.kind === 'shoot' && b.owner === p.i) {
    const power = a.power;
    const speed = shotSpeed(power, p.attrs.shooting);
    let err = 0.02 + 0.12 * power * power * (1.3 - p.attrs.shooting);
    // From distance a shot is harder to place (LONG_SHOT_ERR).
    err += clamp(dist(p.pos, oppGoal(s, team)) - 16, 0, 14) * LONG_SHOT_ERR * (1.3 - p.attrs.shooting);
    if (s.restart?.kind === 'penalty') err *= 0.45; // a dead ball from 11 m: no one closing you down
    kick(s, p, a.target, speed, err, -1);
    if (a.lift && a.lift > 0) {
      b.z = SHOT_Z0;
      b.vz = a.lift;
      // A human's rising shot scatters up and down too: more with power, less for a good shooter.
      if (isHumanControlled(s, p)) b.vz = Math.max(0, b.vz + gauss(s.rng) * power * power * (1.3 - p.attrs.shooting) * (s.restart?.kind === 'penalty' ? 0.45 : 1));
    }
    b.passFrom = -1;
    countShot(s, team, true);
    return;
  }
  if (a.kind === 'tackle' && p.tackleCd === 0 && b.owner !== p.i && s.phase === 'play') {
    const before = len(p.vel);
    const lunge = norm(sub(a.target, p.pos));
    if (a.slide) {
      // A slide is a committed lunge along the ground toward the target. It is judged each tick
      // of the slide (slideTackles), when his feet reach the ball or he meets the man.
      p.tackleCd = 70;
      const len0 = clamp(dist(a.target, p.pos), 1, SLIDE_TRAVEL);
      p.slide = { dir: lunge, left: len0, len: len0, ticks: 0 };
      p.stun = SLIDE_TICKS + SLIDE_DOWN;
      p.vel = scale(lunge, Math.max(SLIDE_SPEED, before));
      slideContact(s, p, before);
      return;
    }
    p.tackleCd = 36;
    p.vel = add(p.vel, scale(lunge, 3));
    const owner = b.owner >= 0 ? s.players[b.owner] : null;
    if (!owner || owner.team === team || dist(owner.pos, p.pos) > STAND_REACH || b.inHands) {
      if (!owner) lateChallenge(s, p, before);
      p.stun = 10;
      return;
    }
    resolveTackle(s, p, owner, false, before);
  }
}

/** Beyond this a standing tackle is at full stretch (out to STAND_REACH): less sure, and half as likely to foul. */
const STAND_EDGE = 1.7;
/** A slide (SLIDE_TRAVEL at most): how fast it starts, how long it lasts, how long he is down after. */
const SLIDE_SPEED = 11;
const SLIDE_TICKS = 30;
const SLIDE_DOWN = 16;
/** A slide that has gone this far (m) when it meets the man is fully committed (resolveTackle's `commit`). */
const SLIDE_COMMITTED = 2.5;
/** Where his feet are ahead of him while sliding, and how close to the ball they must come. */
const SLIDE_FEET = 0.6;
const SLIDE_TOUCH = 0.6;

/** A late one: the man has just released the ball and is right there. */
function lateChallenge(s: MatchState, p: MatchPlayer, before: number): boolean {
  const b = s.ball;
  const victim = s.players.find((q) => q.team !== p.team && !q.sentOff && q.kickCd > 9 && b.lastTouch === q.i && dist(q.pos, p.pos) < 1.4);
  if (!victim || next(s.rng) >= 0.5 * (1.3 - care(s, p))) return false;
  const sev = severityOf(0.42 + 0.3 * clamp((before - 4) / 4, 0, 1) + 0.25 * next(s.rng));
  const kept = b.receiver >= 0 && s.players[b.receiver].team === victim.team;
  // He has already shot: the shot plays out and the challenge is dealt with after it.
  const afterShot = b.receiver < 0 && b.kickedBy === victim.i && goalBound(s, victim.team);
  return judgeFoul(s, { offender: p, victim, severity: sev, attempt: false, keptBall: kept, afterShot });
}

/** A challenge on the man with the ball that has reached him: won, missed, or a foul. */
/**
 * `commit` (slides): how committed the lunge was when it met the man, 0..1. A short slide is
 * judged more like a standing tackle; a full-length one like a challenge at full speed.
 */
function resolveTackle(s: MatchState, p: MatchPlayer, owner: MatchPlayer, slide: boolean, before: number, commit = 1): void {
  const b = s.ball;
  const team = p.team;
  // Coming through the back of the man: rarely gets the ball, often fouls. A slide is riskier still.
  const fromBehind = dot(norm(sub(owner.pos, p.pos)), owner.facing) > 0.5;
  let pWin = clamp(0.35 + 0.7 * p.attrs.defending - 0.5 * owner.attrs.dribbling - (slide ? 0.08 : 0), 0.1, 0.88);
  if (fromBehind) pWin *= 0.8;
  if (owner.role === 'GK' && inOwnBox(s, owner.team, owner.pos)) pWin *= 0.25;
  // A standing tackle at full stretch is a little less sure.
  if (!slide) pWin *= 1 - 0.25 * clamp((dist(owner.pos, p.pos) - STAND_EDGE) / (STAND_REACH - STAND_EDGE), 0, 1);
  const won = next(s.rng) < pWin;
  const fast = slide ? commit : clamp((before - 6.5) / 2.5, 0, 1);
  let pFoul = won ? (fromBehind ? 0.2 : 0.025) : 0.2 + (fromBehind ? 0.3 : 0) + 0.12 * fast;
  pFoul *= 2.05 - 0.9 * care(s, p);
  // A booked CPU player goes in more carefully.
  if (p.yellow > 0 && !isHumanControlled(s, p)) pFoul *= 0.45;
  // At full stretch a standing tackle is more a poke than a challenge through the man, and so
  // is a slide that meets him before it is fully committed.
  if (!slide && dist(owner.pos, p.pos) > STAND_EDGE) pFoul *= 0.5;
  if (slide) pFoul *= 0.5 + 0.5 * commit;
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
    touchedBy(b, p);
    b.noPickup[owner.i] = 24;
    owner.stun = 18;
    if (slide) p.stun = 14;
    s.stats[team].tackles++;
    // Law 11: winning the ball is a deliberate play; his teammates' positions are judged from here.
    noteBallPlayed(s, p);
  } else {
    p.stun = slide ? 40 : 26;
    p.tackleCd = slide ? 90 : 50;
  }
}

/** Has a slide reached the ball or the man this tick? Judge it there. True when it is over. */
function slideContact(s: MatchState, p: MatchPlayer, before: number): boolean {
  const sl = p.slide;
  if (!sl || s.phase !== 'play') return false;
  const b = s.ball;
  const feet = add(p.pos, scale(sl.dir, SLIDE_FEET));
  const owner = b.owner >= 0 ? s.players[b.owner] : null;
  const done = () => {
    p.slide = null;
    p.vel = scale(p.vel, 0.3);
    return true;
  };
  if (owner && owner.team !== p.team && !b.inHands) {
    // His feet reach the ball, or he slides into the man from in front of him or the side.
    const toMan = sub(owner.pos, p.pos);
    if (dist(feet, b.pos) < SLIDE_TOUCH + BALL_R || (len(toMan) < PLAYER_R * 2 + 0.1 && dot(sl.dir, norm(toMan)) > 0.4)) {
      resolveTackle(s, p, owner, true, before, clamp((sl.len - sl.left) / SLIDE_COMMITTED, 0.2, 1));
      return done();
    }
    return false;
  }
  if (owner && owner.team !== p.team && b.inHands) {
    // A keeper with the ball in his hands may not be challenged (Law 12): sliding into him is a foul.
    const toMan = sub(owner.pos, p.pos);
    if (len(toMan) < PLAYER_R * 2 + 0.1) {
      const commit = clamp((sl.len - sl.left) / SLIDE_COMMITTED, 0.2, 1);
      judgeFoul(s, { offender: p, victim: owner, severity: severityOf(0.3 + 0.25 * commit + 0.32 * next(s.rng)), attempt: false, keptBall: true });
      return done();
    }
    return false;
  }
  if (!owner && b.z < FOOT_Z && dist(feet, b.pos) < SLIDE_TOUCH + BALL_R && b.noPickup[p.i] === 0) {
    // A loose ball: he gets a foot to it and pokes it on (Law 11: a deliberate play).
    if (offsideOnTouch(s, p, true)) return done();
    touched(s, p);
    noteBallPlayed(s, p);
    b.vel = add(scale(sl.dir, 4), scale(b.vel, 0.2));
    b.kickedBy = -1;
    b.receiver = -1;
    b.passFrom = -1;
    b.noPickup[p.i] = 12;
    return done();
  }
  // Sliding into a man who has just released the ball: judged once, when the slide reaches him.
  if (!owner && !sl.lateJudged && s.players.some((q) => q.team !== p.team && !q.sentOff && q.kickCd > 9 && b.lastTouch === q.i && dist(q.pos, p.pos) < 1.4)) {
    sl.lateJudged = true;
    // Rated by how committed the slide was, not its speed (a short slide is not a full-speed lunge).
    if (lateChallenge(s, p, 4 + 4 * clamp((sl.len - sl.left) / SLIDE_COMMITTED, 0.2, 1))) return done();
  }
  return false;
}

/** Slides under way: carry each slider along, then see whether he has reached the ball or the man. */
function slideTackles(s: MatchState): void {
  for (const p of s.players) {
    const sl = p.slide;
    if (!sl) continue;
    if (p.sentOff || s.phase !== 'play') {
      p.slide = null;
      continue;
    }
    sl.ticks++;
    const speed = Math.max(4, SLIDE_SPEED - 0.25 * sl.ticks);
    const stepLen = Math.min(sl.left, speed * DT);
    p.vel = scale(sl.dir, speed);
    p.pos = add(p.pos, scale(sl.dir, stepLen));
    sl.left -= stepLen;
    if (slideContact(s, p, speed)) continue;
    if (sl.left <= 1e-6 || sl.ticks >= SLIDE_TICKS) {
      p.slide = null;
      p.vel = scale(p.vel, 0.2);
      p.stun = Math.min(p.stun, SLIDE_DOWN);
    }
  }
}

/**
 * The ball has just been struck: is it an attempt on goal? A shot (`aimed`) counts when it
 * heads toward the goal line from within 35 m. A lofted ball or header only counts when it
 * would cross the line no more than 4 m wide of a post and 3 m over the bar, and does not
 * come down well short of it (that is a ball into the box). On target: it would go in
 * under the bar.
 */
function countShot(s: MatchState, team: 0 | 1, aimed = false): boolean {
  const b = s.ball;
  const gx = oppGoal(s, team).x;
  const gap = gx - b.pos.x;
  if (Math.abs(gap) > 35 || Math.abs(b.vel.x) < 1e-6 || Math.sign(gap) !== Math.sign(b.vel.x)) return false;
  const t = gap / b.vel.x;
  const y = b.pos.y + b.vel.y * t;
  let z = 0;
  if (b.z > 0 || b.vz > 0) {
    const tLand = (b.vz + Math.sqrt(b.vz * b.vz + 2 * GRAVITY * b.z)) / GRAVITY;
    if (tLand < t) {
      // Comes down before the line: a shot only if it bounces in from close by.
      if (!aimed && Math.abs(b.vel.x) * (t - tLand) > 4) return false;
    } else z = b.z + b.vz * t - 0.5 * GRAVITY * t * t;
  }
  if (!aimed && (Math.abs(y - PITCH_H / 2) > GOAL_W / 2 + 4 || z > GOAL_BAR_H + 3)) return false;
  s.stats[team].shots++;
  if (inGoalMouth(y) && z < GOAL_BAR_H) s.stats[team].onTarget++;
  return true;
}

/**
 * A cross from the flank in the final third can be charged down by a
 * defender right in front of the crosser: it comes off him and usually goes
 * behind for a corner. Returns true if it was blocked.
 */
function blockCross(s: MatchState, p: MatchPlayer): boolean {
  if (s.restart || teamX(s, p.team, p.pos.x) < 0.68 || Math.abs(p.pos.y - PITCH_H / 2) < GOAL_W) return false;
  const b = s.ball;
  const dir = norm(b.vel);
  for (const o of s.players) {
    if (o.team === p.team || o.sentOff || o.stun > 0 || o.role === 'GK') continue;
    const to = sub(o.pos, p.pos);
    const d = len(to);
    if (d > 2.2 || dot(to, dir) < d * 0.5) continue;
    if (next(s.rng) > 0.3 + 0.25 * o.attrs.defending) return false;
    const side = p.pos.y < PITCH_H / 2 ? -1 : 1;
    b.vel = { x: attackDir(s, p.team) * range(s.rng, 3, 9), y: side * range(s.rng, 1, 6) };
    b.vz = range(s.rng, 1, 4);
    b.z = 0.8;
    b.lastTouch = o.i;
    b.kickedBy = -1;
    b.noPickup[o.i] = 12;
    touchedBy(b, o);
    return true;
  }
  return false;
}

/**
 * How a shot from the free kick in progress would be struck (kicks.ts setPieceStrike): over the wall with dip, or
 * bent round it, to where its line crosses the goal line (the pointer may be short of it, or past it). Pure, no
 * rng: the renderers draw it as the aim while the human holds the button, and strikeFreeKick adds the error.
 */
export function freeKickPlan(s: MatchState, p: MatchPlayer, target: Vec, power: number, curl: number): StrikePlan & { from: Vec } {
  const from = s.restart?.spot ?? s.ball.pos;
  const goal = oppGoal(s, p.team);
  const dx = target.x - from.x;
  const toLine = goal.x - from.x;
  const at = Math.abs(dx) > 1e-6 && Math.sign(dx) === Math.sign(toLine) ? add(from, scale(sub(target, from), toLine / dx)) : target;
  const w = s.wall;
  const wall = w && w.team !== p.team ? w.players.map((i) => s.players[i]).filter((m) => !m.sentOff && dist(m.pos, from) < RETREAT + 3).map((m) => m.pos) : [];
  return { ...setPieceStrike(from, at, shotSpeed(power, p.attrs.shooting), curl, p.attrs.shooting, power, wall), from };
}

/**
 * A shot from a free kick (human or CPU), as freeKickPlan has it, with the striker's error on top. A dead ball and
 * nobody closing him down: less sideways error than in open play, and none for distance; the height still scatters
 * with power.
 */
function strikeFreeKick(s: MatchState, p: MatchPlayer, a: Extract<Action, { kind: 'shoot' }>): void {
  const b = s.ball;
  const plan = freeKickPlan(s, p, a.target, a.power, a.curl ?? 0);
  const skill = 1.3 - p.attrs.shooting;
  kick(s, p, add(b.pos, plan.dir), plan.speed, (0.02 + 0.12 * a.power * a.power * skill) * 0.7, -1);
  b.z = SHOT_Z0;
  b.vz = Math.max(0, plan.vz + gauss(s.rng) * a.power * a.power * skill * 0.6);
  b.spin = plan.side || plan.top ? { side: plan.side, top: plan.top, dir: plan.normal, by: p.i } : null;
  b.passFrom = -1;
  countShot(s, p.team, true);
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
    b.passFrom = p.i;
    s.stats[p.team].passAttempts++;
  } else if (r.kind === 'freekick' && action.kind === 'shoot') {
    s.phase = 'play';
    strikeFreeKick(s, p, action);
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
  s.poss = r.team;
  b.setPiece = r.kind;
  b.setPieceDirect = r.direct;
  b.noPickup[p.i] = 24;
  // Laws 8, 13-17: he may not play it again until someone else has touched it (rules.ts
  // secondTouch); a keeper may not pick up his own goal kick or free kick either (Law 12).
  b.restartBy = p.i;
  b.noHands = p.role === 'GK' ? p.i : -1;
  if (NO_OFFSIDE.has(r.kind)) s.offside = null;
  // The wall jumps to a shot; anything else, and it breaks up at once.
  if (s.wall) {
    if (r.kind === 'freekick' && action.kind === 'shoot') s.wall.struck = s.tick;
    else s.wall = null;
  }
  pushEvent(s, { kind: 'restartTaken', ...eventBase(s, r.team, p.i), restart: r.kind, spot: { ...r.spot } });
  if (r.kind === 'penalty') {
    const gk = goalkeeper(s, r.team === 0 ? 1 : 0);
    const tLine = Math.abs((ownGoal(s, gk.team).x - b.pos.x) / (b.vel.x || 1e-6));
    const side = penaltyDive(s, gk, b.pos.y + b.vel.y * tLine);
    // He commits as it is struck: a dive to that side (or he stays up in the middle).
    if (side !== 0) gk.dive = { dir: { x: 0, y: side }, speed: diveSpeed(gk), ticks: DIVE_TICKS + DIVE_HOLD, travel: DIVE_TICKS, z: 0.9 };
  }
}

// ---------------------------------------------------------------------------
// Physics

function movePlayer(s: MatchState, p: MatchPlayer, intent: Intent): void {
  if (p.sentOff || p.slide) return; // a slide carries him (slideTackles)
  if (p.dive) {
    if (p.dive.ticks > 0) {
      // Committed to the dive: it carries him across the goal whatever he wanted, he stays
      // stretched out on the floor for a moment, then he gets up.
      p.dive.ticks--;
      p.vel = p.dive.travel > 0 ? scale(p.dive.dir, p.dive.speed) : { x: 0, y: 0 };
      if (p.dive.travel > 0) p.dive.travel--;
      p.pos = { x: p.pos.x + p.vel.x * DT, y: p.pos.y + p.vel.y * DT };
      if (p.dive.ticks === 0) {
        p.stun = Math.max(p.stun, DIVE_DOWN);
        p.vel = scale(p.vel, 0.25);
      }
      return;
    }
    if (p.stun === 0) p.dive = null;
  }
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
  // Research: pros average about 7 m/s^2 over 10 m from a standing start; a game wants far
  // more bite than that, so the human's player stays at 32 (26 with the ball), the CPU's at 24 (18).
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
    // Research: turn slower at a sprint than at a jog.
    const turn = base * (human ? 1.7 : 1) * (p.sprinting ? 0.7 : 1) * DT;
    // A human's facing follows where they are steering, not where they have got to.
    const want = steering ? intent.move : scale(p.vel, 1 / speed);
    p.facing = norm(add(p.facing, scale(sub(want, p.facing), Math.min(1, turn))));
  }
  p.pos.x = clamp(p.pos.x, -RUN_OFF, PITCH_W + RUN_OFF);
  p.pos.y = clamp(p.pos.y, -RUN_OFF, PITCH_H + RUN_OFF);
}

/** Law 12: a keeper with the ball in his hands may not be challenged. Opponents are kept this far off him. */
export const KEEPER_SPACE = 1.5;
/** Opponents this close when he releases it can't touch the ball for RELEASE_CLEAR_TICKS (Law 12). */
const RELEASE_CLEAR = 2.5;
const RELEASE_CLEAR_TICKS = 20;

function separate(s: MatchState): void {
  const ps = s.players;
  // A keeper holding the ball does not get bundled about: he doesn't move for anyone.
  const b0 = s.ball;
  const holder = b0.owner >= 0 && b0.inHands && ps[b0.owner].role === 'GK' ? b0.owner : -1;
  // Nor does a man standing in a free-kick wall (or in the air from it): the wall stands shoulder to shoulder,
  // closer than anyone else is let stand, and nobody shoves it out of shape.
  const planted = wallPlanted(s);
  for (let a = 0; a < ps.length; a++) {
    if (ps[a].sentOff) continue;
    for (let b = a + 1; b < ps.length; b++) {
      if (ps[b].sentOff) continue;
      const dx = ps[b].pos.x - ps[a].pos.x;
      const dy = ps[b].pos.y - ps[a].pos.y;
      if (dx > PLAYER_R * 2 || dx < -PLAYER_R * 2 || dy > PLAYER_R * 2 || dy < -PLAYER_R * 2) continue;
      const pa = planted.includes(a);
      const pb = planted.includes(b);
      if (s.wall && s.wall.players.includes(a) && s.wall.players.includes(b)) continue; // they squeeze into line together
      const l = Math.sqrt(dx * dx + dy * dy);
      const overlap = PLAYER_R * 2 - l;
      if (overlap > 0 && l > 1e-6) {
        const ka = a === holder || pa ? 0 : b === holder || pb ? 1 : 0.5;
        const kb = 1 - ka;
        ps[a].pos = { x: ps[a].pos.x - (dx * overlap * ka) / l, y: ps[a].pos.y - (dy * overlap * ka) / l };
        ps[b].pos = { x: ps[b].pos.x + (dx * overlap * kb) / l, y: ps[b].pos.y + (dy * overlap * kb) / l };
      }
    }
  }
  if (holder < 0) return;
  const gk = ps[holder];
  // He stays in front of his line, and opponents give him room to release it.
  const g = ownGoal(s, gk.team);
  const out = attackDir(s, gk.team);
  if ((gk.pos.x - g.x) * out < 0.5) gk.pos = { x: g.x + out * 0.5, y: gk.pos.y };
  for (const o of ps) {
    if (o.team === gk.team || o.sentOff) continue;
    const d = sub(o.pos, gk.pos);
    const l = len(d);
    if (l < KEEPER_SPACE) o.pos = add(gk.pos, scale(l > 1e-6 ? scale(d, 1 / l) : { x: out, y: 0 }, KEEPER_SPACE));
  }
}

/** A human's header at goal: metres across the goal per metre the pointer is to the side of the striker. */
const HEADER_AIM_GAIN = 5;

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
  // A shot the keeper got a hand to and could not keep out is the shooter's goal, not his own.
  const shooter = last && last.team !== team && last.role === 'GK' && b.parriedFrom !== undefined && b.parriedFrom >= 0 ? s.players[b.parriedFrom] : null;
  const credited = shooter ?? last;
  const scorer = credited ? (credited.team === team ? credited.name : `${credited.name} (OG)`) : 'Unknown';
  if (s.advantage && s.advantage.team === team) downgradeDogso(s);
  s.advantage = null;
  pushEvent(s, { kind: 'goal', ...eventBase(s, team, credited ? credited.i : -1), scorer, ownGoal: !!credited && credited.team !== team, from: straightFrom ?? 'play' });
  flushPendingCards(s);
  if (s.abandoned) return;
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
    // The goal at x < 0 is attacked by whichever side defends the other end this half.
    if (inGoalMouth(p.y) && b.z < GOAL_BAR_H - BALL_R) scoreGoal(s, teamAtEnd(s, p.x < 0 ? 1 : 0));
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
    if (o.role === 'GK' && inOwnBox(s, o.team, o.pos)) o.facing = { x: attackDir(s, o.team), y: 0 };
    const spot = add(o.pos, scale(o.facing, PLAYER_R + BALL_R + 0.23));
    b.vz = 0;
    if (b.touch > 0) {
      // First touch: the ball keeps some of its momentum and settles into the
      // feet over a few ticks instead of snapping to them. Taken on the chest or
      // thigh, it drops to the feet as it settles.
      b.vel = add(b.vel, scale(sub(o.vel, b.vel), 0.22));
      b.pos = add(b.pos, scale(b.vel, DT));
      b.pos = add(b.pos, scale(sub(spot, b.pos), 0.18 + 0.32 * (1 - b.touch / 14)));
      b.z = b.z > 0.02 ? b.z * 0.8 : 0;
      b.touch--;
    } else {
      b.pos = add(b.pos, scale(sub(spot, b.pos), 0.5));
      b.vel = { ...o.vel };
      b.z = 0;
    }
    if (b.inHands) b.z = 1.1;
    if (live) checkLines(s);
    return;
  }
  // Spin lasts until anyone else touches it, or it lands.
  if (b.spin && b.lastTouch !== b.spin.by) b.spin = null;
  const speed = len(b.vel);
  if (b.z > 0 || b.vz > 0) {
    // In the air: gravity, light drag, damped bounce. z never goes below 0. A struck set piece bends and dips (Ball.spin).
    b.vz -= (GRAVITY + (b.spin?.top ?? 0)) * DT;
    b.z += b.vz * DT;
    b.vel = scale(b.vel, 1 - AIR_DRAG * DT);
    if (b.spin) b.vel = add(b.vel, scale(b.spin.dir, b.spin.side * DT));
    if (b.z <= 0) {
      b.spin = null;
      b.z = 0;
      if (b.vz < -1.5) {
        b.vz = -b.vz * BOUNCE_DAMP;
        b.vel = scale(b.vel, BOUNCE_KEEP);
      } else b.vz = 0;
    }
  } else if (speed > 0) {
    const ns = Math.max(0, speed - rollDecel(speed) * DT);
    b.vel = scale(b.vel, ns / speed);
  }
  const prev = { ...b.pos };
  b.pos = add(b.pos, scale(b.vel, DT));
  goalFrame(s, prev.x);
  if (!live) return;
  if (checkLines(s)) return;
  contacts(s, prev);
}

// ---------------------------------------------------------------------------
// The ball meets a body
//
// Each tick the ball's path (where it was to where it is, so a fast ball can't
// tunnel) is tested against every player's body, by height:
//   feet      below FOOT_Z: controlled by whoever reaches it, if it isn't too hot
//   chest     FOOT_Z..CHEST_Z (to CUSHION_Z for a ball from a teammate): taken
//             on the thigh or chest when it is close, then drops to the feet
//   head      up to HEAD_Z: headers (clearances, and at goal in the box)
//   body      anything else that hits a player below BODY_TOP bounces off him
// and a keeper in his box reaches with his hands (keeperReach): standing, or
// along the line of a dive. Every bounce is a reflection off the surface it
// hit, so deflections are physical and, apart from a small seeded spin,
// repeatable.

/** Below this the ball is at the feet. */
export const FOOT_Z = 0.5;
/** Thigh and chest control up to here. */
export const CHEST_Z = 1.5;
/** A ball from a teammate can be cushioned on the chest or head up to here. */
export const CUSHION_Z = 1.9;
/** The body a ball bounces off: legs and torso as a cylinder this wide, this tall. */
export const BODY_R = 0.3;
export const BODY_TOP = 1.85;
/** Horizontal reach of a header (a step and a jump), and of chest control. */
const HEAD_REACH = 0.7;
const CHEST_REACH = 0.6;
/** The intended receiver reaches this far for a ball at his feet; anyone else less, the faster it is. */
export const RECEIVE_REACH = 1.23;
const footReach = (speed: number): number => clamp(1.0 - 0.02 * speed, 0.65, 0.95);
/** Ticks after a kick before an opponent can stretch for the ball (about 0.2 s); until then only his body is in the way. */
const REACT_TICKS = 12;

/** A keeper's dive: the longest it carries him, how long he stays stretched out (hands still up) at least, how long he is down after, how fast. */
export const DIVE_TICKS = 27;
const DIVE_HOLD = 8;
/** He launches when the ball is this many ticks further off than his dive takes. */
const DIVE_LEAD = 6;
const DIVE_DOWN = 24;
/** A diving or lying keeper's body blocks a ball below this height along the whole line of the dive. */
const DIVE_BODY_Z = 0.8;
// Tuned so a 0.9 keeper saves about 90% of evenly placed shots on target from 12-25 m (a
// well-struck corner still beats him) and a 0.3 keeper about half (tests/tactics.test.ts).
export const diveSpeed = (gk: MatchPlayer): number => 1.2 + 2.6 * gk.attrs.goalkeeping;
/** Seconds a dive carries him at most (at most DIVE_TICKS). */
export const diveSpan = (gk: MatchPlayer): number => Math.min(DIVE_TICKS / TICK_HZ, 0.12 + 0.35 * gk.attrs.goalkeeping);
/** How far his hands reach past his body along a dive. */
export const diveArm = (gk: MatchPlayer): number => 0.6 + 0.1 * gk.attrs.goalkeeping;
/** Standing, his hands cover this radius up to 1.9 m (and a little less above, up to KEEPER_REACH_Z). */
export const standReach = (gk: MatchPlayer, z: number): number => (z <= 1.9 ? 0.55 + 0.35 * gk.attrs.goalkeeping : 0.45 + 0.25 * gk.attrs.goalkeeping);
/** Law 12: a keeper may hold the ball for about six seconds. Then the CPU plays it for a human. */
export { KEEPER_HOLD_TICKS };

/** Law 12 (handling): a keeper may not pick up a ball a teammate deliberately kicked or threw to him. */
function keeperHands(s: MatchState, p: MatchPlayer): boolean {
  if (p.role !== 'GK' || !inOwnBox(s, p.team, p.pos) || handsBarred(s, p)) return false;
  const k = s.ball.kickedBy;
  return !(k >= 0 && k !== p.i && s.players[k].team === p.team);
}

/** Closest point on segment a-b to p, and how far along (0..1). */
function closestOn(p: Vec, a: Vec, b: Vec): { pt: Vec; t: number } {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  const t = l2 < 1e-12 ? 0 : clamp(((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2, 0, 1);
  return { pt: add(a, scale(ab, t)), t };
}

/** Distance between segments a-b and c-d (2D), with the closest point on c-d and how far along it. */
function segSeg(a: Vec, b: Vec, c: Vec, d: Vec): { d: number; pt: Vec; t: number } {
  // The four endpoint-to-segment distances, then the crossing case (no per-call arrays: this runs every tick).
  const ra = closestOn(a, c, d);
  let best = { d: dist(a, ra.pt), pt: ra.pt, t: ra.t };
  const rb = closestOn(b, c, d);
  const db = dist(b, rb.pt);
  if (db < best.d) best = { d: db, pt: rb.pt, t: rb.t };
  const dc = distToSegment(c, a, b);
  if (dc < best.d) best = { d: dc, pt: c, t: 0 };
  const dd = distToSegment(d, a, b);
  if (dd < best.d) best = { d: dd, pt: d, t: 1 };
  // Crossing segments.
  const r = sub(b, a);
  const sv = sub(d, c);
  const den = r.x * sv.y - r.y * sv.x;
  if (Math.abs(den) > 1e-12) {
    const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
    const v = ((c.x - a.x) * sv.y - (c.y - a.y) * sv.x) / den;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) best = { d: 0, pt: add(c, scale(sv, u)), t: u };
  }
  return best;
}

/**
 * How close this tick's ball path (from -> to) comes to `p`, counted only once the ball has
 * come level with him (its closest approach falls in this tick) or is right at him: a ball
 * is played as it reaches a player, not from a metre in front of him.
 */
function approach(p: Vec, from: Vec, to: Vec): number {
  const c = closestOn(p, from, to);
  const d = dist(c.pt, p);
  return c.t < 1 || dist(to, p) < BODY_R + BALL_R + 0.1 ? d : Infinity;
}

/** A keeper's hands as a segment and radius: around him standing, or out along his dive. */
export function keeperReach(gk: MatchPlayer, z: number): { a: Vec; b: Vec; r: number } {
  // Diving, or lying where the dive left him: his hands are out along its line.
  if (gk.dive) return { a: gk.pos, b: add(gk.pos, scale(gk.dive.dir, diveArm(gk))), r: gk.dive.ticks > 0 ? 0.15 : 0.2 };
  return { a: gk.pos, b: gk.pos, r: standReach(gk, z) };
}

/** Someone other than the last player on it touched the ball: what that resets. */
function touched(s: MatchState, p: MatchPlayer): void {
  const b = s.ball;
  b.whiff = -1;
  b.parriedFrom = -1;
  if (b.setPiece && b.lastTouch !== p.i) b.setPiece = null;
  if (b.passFrom >= 0 && b.passFrom !== p.i) b.passFrom = -1;
  b.lastTouch = p.i;
  b.receiver = -1;
  b.touch = 0;
  b.kickedBy = -1;
  touchedBy(b, p);
}

/** Someone touched the ball: a restart taker or a keeper who released it is free of it once anyone else has. */
function touchedBy(b: MatchState['ball'], p: MatchPlayer): void {
  if (b.restartBy !== undefined && b.restartBy !== p.i) b.restartBy = -1;
  if (b.noHands !== undefined && b.noHands !== p.i) b.noHands = -1;
}

/**
 * The ball bounces off a body. `n` points from the surface it hit toward the ball; the
 * velocity into the surface is reflected with restitution `e`, some of the player's own
 * movement is passed on, and a small seeded spin keeps it from being too tidy.
 */
function bounceOff(s: MatchState, p: MatchPlayer, at: Vec, n: Vec, e: number, spin: number): void {
  const b = s.ball;
  touched(s, p);
  const vn = dot(b.vel, n);
  if (vn < 0) b.vel = sub(b.vel, scale(n, (1 + e) * vn));
  b.vel = add(scale(b.vel, 0.8), scale(p.vel, 0.35));
  if (spin) b.vel = rotate(b.vel, range(s.rng, -spin, spin));
  if (b.z > 0.05) b.vz = b.vz > 0 ? b.vz * 0.5 : -b.vz * 0.3;
  b.redirectedAt = s.tick;
  // Out of the body, so it can't be inside him next tick.
  const gap = BODY_R + BALL_R + 0.02;
  if (dist(b.pos, at) < gap) b.pos = add(at, scale(n, gap));
  b.noPickup[p.i] = Math.max(b.noPickup[p.i], 8);
}

/** Unit vector from `from` toward the ball, or straight back along its path when they coincide. */
function awayFrom(s: MatchState, from: Vec): Vec {
  const d = sub(s.ball.pos, from);
  const l = len(d);
  if (l > 1e-4) return scale(d, 1 / l);
  const v = len(s.ball.vel);
  return v > 1e-6 ? scale(s.ball.vel, -1 / v) : { x: 1, y: 0 };
}

function contacts(s: MatchState, from: Vec): void {
  const b = s.ball;
  const speed = len(b.vel) + Math.abs(b.vz) * 0.5;
  const z = b.z;
  const lastTeam = b.lastTouch >= 0 ? s.players[b.lastTouch].team : -1;

  // Keepers' hands first: a keeper who gets a hand to it catches or parries it.
  let keeper: { p: MatchPlayer; pt: Vec; t: number; d: number } | null = null;
  for (const p of s.players) {
    if (p.role !== 'GK' || b.noPickup[p.i] > 0 || p.sentOff || !keeperHands(s, p)) continue;
    // Down after a dive he can still get a hand to a low ball along the line he went.
    const lying = p.stun > 0;
    if (lying ? !p.dive || z > 0.9 : z > KEEPER_REACH_Z) continue;
    const hr = keeperReach(p, z);
    const c = hr.a === hr.b ? { d: approach(p.pos, from, b.pos), pt: p.pos, t: 0 } : segSeg(from, b.pos, hr.a, hr.b);
    if (c.d < hr.r + BALL_R && (!keeper || c.d < keeper.d)) keeper = { p, pt: c.pt, t: c.t, d: c.d };
  }
  if (keeper) {
    keeperTouch(s, keeper.p, keeper.pt, keeper.t, keeper.d);
    return;
  }

  // Feet and chest: the nearest player who can reach it tries to control it. Just after a
  // kick an opponent has had no time to react: only a ball played straight at him is his.
  const kicker = b.kickedBy >= 0 ? s.players[b.kickedBy] : null;
  const fresh = !!kicker && kicker.kickCd > 0 && 18 - kicker.kickCd < REACT_TICKS;
  let best: MatchPlayer | null = null;
  let bestD = Infinity;
  let bestReach = 0;
  for (const p of s.players) {
    if (p.stun > 0 || b.noPickup[p.i] > 0 || p.sentOff || keeperHands(s, p) || b.whiff === p.i) continue;
    // A CPU restart taker leaves it for someone else (a human who plays it again gives away a free kick).
    if (barredSecondTouch(s, p) && !isHumanControlled(s, p)) continue;
    if ((p.air ?? 0) > 0.05) continue; // in the air (a wall jumping): a header or his body, never his feet
    const d = approach(p.pos, from, b.pos);
    let reach: number;
    if (z <= FOOT_Z) reach = b.receiver === p.i ? RECEIVE_REACH : fresh && kicker!.team !== p.team ? BODY_R + BALL_R : footReach(speed);
    else if (z <= (p.team === lastTeam ? CUSHION_Z : CHEST_Z)) reach = CHEST_REACH;
    else continue;
    if (d < reach && d < bestD) {
      best = p;
      bestD = d;
      bestReach = reach;
    }
  }
  if (best) {
    control(s, best, bestD, bestReach);
    return;
  }

  if (z > CHEST_Z && z <= HEAD_Z + WALL_JUMP_Z && header(s)) return;

  // Nobody played it: does it hit someone? Bodies are BODY_R wide up to BODY_TOP; a player on the floor only low down.
  // A man in the air (a wall jumping) is that much higher: his head reaches over, and a low ball can go under him.
  if (z > BODY_TOP + WALL_JUMP_Z) return;
  let hit: MatchPlayer | null = null;
  let hitT = Infinity;
  let hitAt: Vec | null = null;
  for (const p of s.players) {
    if (p.sentOff || b.noPickup[p.i] > 0) continue;
    // Someone stumbling or on the floor is out of it. A keeper diving, or down after a
    // dive, is stretched out along the line he went, low: legs behind him, arms ahead.
    if (p.dive) {
      // In the air at the height he dived to; once down, low.
      if (z > (p.dive.ticks > 0 ? Math.max(DIVE_BODY_Z, p.dive.z + 0.5) : DIVE_BODY_Z)) continue;
      const c = segSeg(from, b.pos, sub(p.pos, scale(p.dive.dir, 0.9)), add(p.pos, scale(p.dive.dir, 0.2)));
      if (c.d < BODY_R + BALL_R && c.t < hitT) {
        hit = p;
        hitT = c.t;
        hitAt = c.pt;
      }
      continue;
    }
    if (p.stun > 0) continue;
    const air = p.air ?? 0;
    if (z > BODY_TOP + air || z + BALL_R < air) continue;
    const c = closestOn(p.pos, from, b.pos);
    if (dist(c.pt, p.pos) < BODY_R + BALL_R && c.t < hitT) {
      hit = p;
      hitT = c.t;
      hitAt = p.pos;
    }
  }
  if (!hit || !hitAt) return;
  // A keeper who may handle it deals with anything that reaches him: it is his to hold or parry.
  if (keeperHands(s, hit) && z <= KEEPER_REACH_Z) {
    // On the floor or mid-dive his legs and body are no place to catch it: no 'into his body' help.
    keeperTouch(s, hit, hitAt, 0, hit.dive ? 1 : dist(hitAt, b.pos));
    return;
  }
  if (offsideOnTouch(s, hit, false)) return;
  // Off the surface it hit: for a keeper stretched out, the nearest point of his body, not his middle.
  const struck = hit.role === 'GK' && b.lastTouch >= 0 && s.players[b.lastTouch].team !== hit.team ? b.lastTouch : -1;
  bounceOff(s, hit, hitAt, awayFrom(s, hitAt), 0.35, 0.12);
  b.parriedFrom = struck;
  offsidePlayed(s, hit, false);
}

/**
 * A player reaches the ball (`d` metres from him, his reach `reach`) at his feet, thigh or
 * chest: he takes it, or it is too hot and comes off him. Stretching for a hot ball that is
 * not coming at his body he may not get a touch at all.
 */
function control(s: MatchState, p: MatchPlayer, d: number, reach: number): void {
  const b = s.ball;
  const receiver = b.receiver === p.i;
  // A dropping ball is harder to kill than its pace across the ground; the man it was meant for
  // is set for it, so its fall counts for less (chest and thigh control of a lofted pass).
  const speed = len(b.vel) + Math.abs(b.vz) * (receiver ? 0.15 : 0.5);
  const chest = b.z > FOOT_Z;
  let limit = 6 + 11 * p.attrs.dribbling + (receiver ? 5 : 0);
  if (chest && !receiver) limit *= 0.75;
  const takes = speed <= limit;
  if (barredSecondTouch(s, p)) {
    secondTouch(s, p);
    return;
  }
  if (offsideOnTouch(s, p, takes)) return;

  if (takes) {
    const from = b.passFrom >= 0 ? s.players[b.passFrom] : null;
    if (from && from.team === p.team && from.i !== p.i) s.stats[p.team].passes++;
    touchedBy(b, p);
    b.owner = p.i;
    b.lastTouch = p.i;
    b.receiver = -1;
    b.passFrom = -1;
    b.kickedBy = -1;
    b.setPiece = null;
    b.inHands = false;
    b.handTicks = 0;
    b.whiff = -1;
    // The man it was meant for takes it cleanly; a loose ball, or one on the chest, takes longer to settle.
    b.touch = receiver && !chest ? clamp(Math.round(speed * 0.6), 3, 8) : clamp(Math.round(speed * 1.2), chest ? 8 : 4, 14);
    b.vz = 0;
    p.holdTicks = 0;
    p.aiTimer = Math.max(p.aiTimer, 4);
    s.poss = p.team;
    // No hold here: the man the human already steers runs on with it. An automatic change of
    // player arms the hold where it happens (give() in human.ts, the handover in step()).
    return;
  }
  // Too hot to control. Not at his body: the stretch may miss it (likelier the further out it is, and for a poor defender).
  const body = BODY_R + BALL_R;
  if (!receiver && d > body && reach > body) {
    // A sharper side reads the pass and gets a foot to it more often (TeamSetup.aiSkill).
    const sharp = 0.2 + 0.7 * clamp(s.teams[p.team].aiSkill, 0, 1);
    const touchChance = clamp((1 - (d - body) / (reach - body)) * (0.45 + 0.45 * p.attrs.defending) * sharp, 0, 1);
    if (next(s.rng) > touchChance) {
      // He can't get a foot to it this time; if it is coming at his body it will still hit him.
      b.whiff = p.i;
      return;
    }
  }
  // It comes off his leg or chest, which he gets in the way of.
  const owner = b.lastTouch >= 0 ? s.players[b.lastTouch] : null;
  const blockNearGoal = !!owner && owner.team !== p.team && b.vel.x * attackDir(s, p.team) < -7 && teamX(s, p.team, p.pos.x) < 0.35;
  bounceOff(s, p, p.pos, awayFrom(s, p.pos), chest ? 0.3 : 0.45, blockNearGoal ? 0.6 : 0.3);
  b.noPickup[p.i] = 12;
  offsidePlayed(s, p, false);
}

/** Keeper's hands reach the ball: he holds it if he can, else he parries it away from goal. */
function keeperTouch(s: MatchState, p: MatchPlayer, pt: Vec, along: number, gap: number): void {
  const b = s.ball;
  const speed = len(b.vel) + Math.abs(b.vz) * 0.5;
  const gk = p.attrs.goalkeeping;
  const diving = !!p.dive && p.dive.ticks > 0;
  const lying = !!p.dive && p.stun > 0;
  let limit = 10 + 12 * gk;
  if (diving) limit *= 0.8 - 0.3 * along; // at full stretch, fingertips: a parry
  else if (lying) limit *= 0.5;
  else if (gap < 0.5) limit *= 1.35; // into his body
  if (b.z > 2.0) limit *= 0.7;
  else if (b.z < 0.3) limit *= 1.1;
  if (offsideOnTouch(s, p, false)) return;
  if (speed <= limit) {
    touchedBy(b, p);
    b.owner = p.i;
    b.lastTouch = p.i;
    b.receiver = -1;
    b.passFrom = -1;
    b.kickedBy = -1;
    b.setPiece = null;
    b.inHands = true;
    b.handTicks = 0;
    b.whiff = -1;
    b.touch = 4;
    b.vz = 0;
    p.holdTicks = 0;
    p.aiTimer = Math.max(p.aiTimer, 4);
    s.poss = p.team;
    if (diving) {
      p.dive!.ticks = 0;
      p.stun = Math.max(p.stun, 18);
      p.vel = { x: 0, y: 0 };
    }
    return;
  }
  // Parried. A ball heading just inside the post that he reaches at full stretch is tipped
  // round it; anything else he palms back out, away from goal and wide.
  const struck = b.lastTouch >= 0 && s.players[b.lastTouch].team !== p.team ? b.lastTouch : -1;
  touched(s, p);
  b.parriedFrom = struck;
  const out = attackDir(s, p.team);
  const g = ownGoal(s, p.team);
  const tLine = Math.abs(b.vel.x) > 1e-6 ? (g.x - b.pos.x) / b.vel.x : -1;
  const yLine = tLine > 0 ? b.pos.y + b.vel.y * tLine : b.pos.y;
  const nearPost = Math.abs(yLine - PITCH_H / 2) > GOAL_W / 2 - 1.9;
  const outside = Math.sign(yLine - PITCH_H / 2) || Math.sign(b.pos.y - PITCH_H / 2) || 1;
  const v = len(b.vel);
  const toLine = Math.abs(g.x - b.pos.x);
  const palm = () => {
    // Palmed: the part of its pace toward goal is turned back (restitution 0.25-0.45). A good
    // keeper pushes it wide; a poor one often spills it back into the six-yard box.
    const e = range(s.rng, 0.25, 0.45);
    const vx = b.vel.x * out < 0 ? -b.vel.x * e : b.vel.x;
    const wide = range(s.rng, -3, 4.5) * (0.4 + 0.6 * gk) + 0.5 * gk;
    b.vel = { x: vx, y: b.vel.y * 0.4 + outside * wide };
    b.vz = Math.max(Math.abs(b.vz) * 0.3, range(s.rng, 0.3, 2.5));
  };
  if (b.z > 1.8) {
    // Up near the bar: tipped over it, still carrying toward the goal line, rising so it
    // clears the bar by at least 0.3 m at the line (a corner). Too close to lift it that
    // much: palmed back out instead.
    const vx = b.vel.x * 0.5;
    const tl = Math.abs(vx) > 0.5 ? toLine / Math.abs(vx) : Infinity;
    const vz = (GOAL_BAR_H + 0.4 - b.z + 0.5 * GRAVITY * tl * tl) / tl;
    if (tl < 1 && vz < 9) {
      b.vel = { x: vx, y: b.vel.y * 0.5 + outside * range(s.rng, 0, 1.5) };
      b.vz = vz + range(s.rng, 0, 1);
    } else palm();
  } else if (nearPost && (diving ? along > 0.4 : gap > 0.4)) {
    // Round the post: sent at half its pace to cross the line at least 0.3 m outside it.
    const post = PITCH_H / 2 + outside * (GOAL_W / 2 + range(s.rng, 0.3, 1.5));
    const head = norm({ x: g.x - b.pos.x, y: post - b.pos.y });
    if (dot(head, scale(b.vel, 1 / Math.max(v, 1e-6))) > Math.cos(1.4)) {
      b.vel = scale(head, v * 0.5);
      b.vz = Math.max(Math.abs(b.vz) * 0.3, range(s.rng, 0.2, 1.5));
    } else palm();
  } else palm();
  b.z = Math.max(b.z, 0.05);
  b.redirectedAt = s.tick;
  const gapR = BODY_R + BALL_R + 0.02;
  if (dist(b.pos, pt) < gapR) b.pos = add(pt, scale(awayFrom(s, pt), gapR));
  b.noPickup[p.i] = 18;
}

/** Seconds until the loose ball has gone `d` metres along its path: rolling friction on the floor, light drag in the air. */
function timeToTravel(b: MatchState['ball'], d: number): number {
  const v = len(b.vel);
  if (v < 1e-6) return Infinity;
  let t0 = 0;
  let v0 = v;
  let left = d;
  if (b.z > 0 || b.vz > 0) {
    // In the air until it lands (later bounces ignored), then rolling at what is left of its pace.
    const tLand = (b.vz + Math.sqrt(b.vz * b.vz + 2 * GRAVITY * b.z)) / GRAVITY;
    const dAir = (v * (1 - Math.exp(-AIR_DRAG * tLand))) / AIR_DRAG;
    if (d <= dAir) return -Math.log(1 - (AIR_DRAG * d) / v) / AIR_DRAG;
    t0 = tLand;
    v0 = v * Math.exp(-AIR_DRAG * tLand) * BOUNCE_KEEP;
    left = d - dAir;
  }
  if (rollTravel(v0, 10) < left) return Infinity;
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (rollTravel(v0, mid) < left) lo = mid;
    else hi = mid;
  }
  return t0 + hi;
}

/**
 * A keeper sees a shot coming that he can't take where he stands: after his reaction time
 * he dives across to where the ball will pass him, low or high, and is on the floor after.
 * Not for a penalty (he commits as it is struck, in takeRestart).
 */
function keeperDives(s: MatchState): void {
  const b = s.ball;
  if (b.owner >= 0 || b.setPiece === 'penalty') return;
  const v = len(b.vel);
  if (v < 7) return;
  for (const team of [0, 1] as const) {
    const gk = goalkeeper(s, team);
    if (!gk || gk.sentOff || gk.stun > 0 || gk.dive || !keeperHands(s, gk) || b.noPickup[gk.i] > 0) continue;
    const out = attackDir(s, team);
    if (b.vel.x * out > -3) continue;
    const g = ownGoal(s, team);
    const tLine = (g.x - b.pos.x) / b.vel.x;
    if (tLine <= 0 || tLine > 1.4) continue;
    const yLine = b.pos.y + b.vel.y * tLine;
    const zAt = (t: number) => (b.z > 0 || b.vz > 0 ? Math.max(0, b.z + b.vz * t - 0.5 * GRAVITY * t * t) : 0);
    if (Math.abs(yLine - PITCH_H / 2) > GOAL_W / 2 + 0.6 || zAt(tLine) > GOAL_BAR_H + 0.4) continue;
    // Reaction time after the ball last changed course (a strike, a header, a deflection):
    // 8 ticks (0.13 s) for the best keeper, 17 (0.28 s) for the worst.
    if (s.tick - (b.redirectedAt ?? -1e9) < Math.min(17, Math.round(20 - 12 * gk.attrs.goalkeeping))) continue;
    const dir = scale(b.vel, 1 / v);
    const along = dot(sub(gk.pos, b.pos), dir);
    if (along < 0) continue;
    const t = timeToTravel(b, along);
    const z = zAt(t);
    const truly = add(b.pos, scale(dir, along));
    // Coming at him (he can take it where he stands), or over his reach: no dive.
    if (dist(truly, gk.pos) <= standReach(gk, z) * 0.85 || z > KEEPER_REACH_Z) continue;
    // Where he reads it will pass him: a weaker keeper misreads it by more, and so does
    // anyone with less time to see it (seeded).
    const misread = gauss(s.rng) * (0.35 + 3 * (1.15 - gk.attrs.goalkeeping) ** 2) * clamp(0.6 / Math.max(t, 0.1), 0.4, 1.5);
    const meet = add(truly, { x: -dir.y * misread, y: dir.x * misread });
    const off = sub(meet, gk.pos);
    const dl = Math.max(len(off), 1e-3);
    // Too far to reach and wide anyway: let it go.
    const arm = diveArm(gk);
    const top = diveSpeed(gk);
    // A better keeper's dive carries him further: 0.25 s of flight for the weakest, 0.45 s for the best.
    const span = diveSpan(gk);
    const maxReach = arm + top * Math.min(span, t) + 0.3;
    if (dl > maxReach && !inGoalMouth(yLine)) continue;
    // Far enough to get his hands to the line of the ball, no further (he must not fly past
    // it). He goes late, timed to land as it arrives: until then he shuffles across (ai.ts),
    // and if he is early he stays stretched out, hands up, until it gets there.
    const travel = clamp(dl - 0.5 * arm, 0.2, top * span);
    const ticks = Math.ceil((travel / top) * TICK_HZ);
    const arrive = Math.ceil(t * TICK_HZ);
    if (arrive > ticks + DIVE_LEAD) continue;
    const hold = clamp(arrive - ticks + 8, DIVE_HOLD, 90);
    gk.dive = { dir: scale(off, 1 / dl), speed: top, ticks: ticks + hold, travel: ticks, z };
  }
}

/**
 * A ball between CHEST_Z and HEAD_Z can be headed: by an opponent of whoever played
 * it (a clearance), or by an attacker in the opponents' box (at goal; a human aims it with
 * the pointer). Teammates elsewhere let it drop to the chest. Returns true if it was headed.
 */
function header(s: MatchState): boolean {
  const b = s.ball;
  const lastTeam = b.lastTouch >= 0 ? s.players[b.lastTouch].team : -1;
  let best: MatchPlayer | null = null;
  let bestD = Infinity;
  for (const p of s.players) {
    if (p.stun > 0 || b.noPickup[p.i] > 0 || p.sentOff || keeperHands(s, p) || b.whiff === p.i) continue;
    if (barredSecondTouch(s, p) && !isHumanControlled(s, p)) continue;
    const zr = b.z - (p.air ?? 0);
    if (zr <= CHEST_Z || zr > HEAD_Z) continue;
    const attacking = p.team === lastTeam && inOwnBox(s, p.team === 0 ? 1 : 0, p.pos);
    if (p.team === lastTeam && !attacking) continue;
    const d = dist(p.pos, b.pos);
    if (d < HEAD_REACH && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  if (!best) return false;
  const p = best;
  // Not every jump connects: he misses it, and it may still hit him.
  if (next(s.rng) > 0.62 + 0.25 * (p.role === 'DEF' ? p.attrs.defending : p.attrs.shooting)) {
    // No second jump at this ball, but his body is still there for it to hit.
    b.whiff = p.i;
    return false;
  }
  const atGoal = p.team === lastTeam;
  if (barredSecondTouch(s, p)) {
    secondTouch(s, p);
    return true;
  }
  if (offsideOnTouch(s, p, !atGoal)) return true;
  touched(s, p);
  // Law 11: a header plays the ball, so his teammates' positions are judged again now.
  offsidePlayed(s, p, !atGoal);
  // Law 12: only a deliberate kick (or a throw-in) to the keeper stops him handling it, never a
  // header. A header at goal still counts as the attacker's strike for the keeper's reactions.
  b.kickedBy = atGoal ? p.i : -1;
  b.passFrom = -1;
  b.noPickup[p.i] = 16;
  b.redirectedAt = s.tick;
  if (atGoal) {
    const goal = oppGoal(s, p.team);
    const gk = goalkeeper(s, p.team === 0 ? 1 : 0);
    const aim = s.humanAim?.[p.team];
    // The human picks the corner by which side of the striker the pointer is (the same pointer
    // steers him, so it can't be out on the post): about 0.65 m either side is the corner.
    const yAim = isHumanControlled(s, p) && aim ? clamp(goal.y + (aim.y - p.pos.y) * HEADER_AIM_GAIN, GOAL_TOP + 0.4, GOAL_BOTTOM - 0.4) : gk.pos.y > PITCH_H / 2 ? GOAL_TOP + 0.9 : GOAL_BOTTOM - 0.9;
    const y = yAim;
    const dir = rotate(norm(sub({ x: goal.x, y }, b.pos)), gauss(s.rng) * (0.08 + 0.16 * (1 - p.attrs.shooting)));
    const sp = 10 + 6 * p.attrs.shooting;
    b.vel = scale(dir, sp);
    const t = dist(b.pos, { x: goal.x, y }) / sp;
    // Down toward the line, bouncing in front of the keeper or under the bar.
    b.vz = clamp((0.6 - b.z) / Math.max(t, 0.2) + 0.5 * GRAVITY * t, -6, 3);
    countShot(s, p.team);
  } else {
    // Head it away: upfield and wide of the goal. Under pressure near goal a glancing header can go behind.
    const nearGoal = inOwnBox(s, p.team, p.pos);
    if (nearGoal && next(s.rng) < 0.42 - 0.2 * p.attrs.defending) {
      const side = b.pos.y < PITCH_H / 2 ? -1 : 1;
      b.vel = { x: -attackDir(s, p.team) * range(s.rng, 7, 12), y: side * range(s.rng, 4, 9) };
      b.vz = 2 + 2 * next(s.rng);
    } else {
      const away = norm(add({ x: attackDir(s, p.team) * 1.2, y: 0 }, scale(norm(sub(b.pos, ownGoal(s, p.team))), 0.8)));
      b.vel = scale(rotate(away, range(s.rng, -0.5, 0.5)), 11 + 4 * p.attrs.defending);
      b.vz = 4 + 2 * next(s.rng);
    }
  }
  return true;
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
/** Quick tactics (HumanInput.tactic): a human side switches mentality, whatever the phase. */
function applyTactics(s: MatchState, input: HumanInput | TeamInputs | undefined): void {
  const inputs = teamInputs(s, input);
  for (const team of [0, 1] as const) {
    const m = MENTALITY_IDS[(inputs[team].tactic ?? 0) - 1];
    if (!m || !s.humans[team]) continue;
    if (m === 'balanced') delete s.teams[team].mentality;
    else s.teams[team].mentality = m;
  }
}

export function teamInputs(s: MatchState, input: HumanInput | TeamInputs | undefined): TeamInputs {
  if (Array.isArray(input)) return [input[0] ?? NO_INPUT, input[1] ?? NO_INPUT];
  const one = input ?? NO_INPUT;
  return !s.humans[0] && s.humans[1] ? [NO_INPUT, one] : [one, NO_INPUT];
}

const IDLE_INTENT: Intent = { move: { x: 0, y: 0 }, throttle: 0 };
const isKick = (a: Action | undefined): a is Action => !!a && (a.kind === 'pass' || a.kind === 'chip' || a.kind === 'loft' || a.kind === 'shoot' || a.kind === 'punt');

/** The human is holding a player still after an automatic switch (human.ts): the CPU positions him meanwhile. */
const heldByCpu = (s: MatchState, p: MatchPlayer, input: HumanInput): boolean => !!s.ctlHold?.[p.team] && input.cursor !== undefined;

/**
 * The intent of a player a human steers. A keeper who has held the ball for KEEPER_HOLD_TICKS
 * (Law 12, six seconds) has the CPU play it for the human.
 */
function humanOrTimeout(s: MatchState, p: MatchPlayer, input: HumanInput): Intent {
  const b = s.ball;
  if (p.role === 'GK' && b.owner === p.i && b.inHands && (b.handTicks ?? 0) >= KEEPER_HOLD_TICKS) {
    p.holdTicks = 1e6;
    return aiIntent(s, p);
  }
  return humanIntent(s, p, input);
}

/** A team-mate this close (m) to his restart set-up place is about to stop there (queuedRestartKick). */
const RESTART_NEAR_PLACE = 4;

/** A restart kick clicked during set-up, aimed again from where the taker now stands: to the team-mate it picked, wherever he is now. */
function queuedRestartKick(s: MatchState, p: MatchPlayer, q: { input: HumanInput; receiver: number }): Action | null {
  const mate = q.receiver >= 0 ? s.players[q.receiver] : null;
  if (q.input.pass && mate && !mate.sentOff) {
    // Nearly at the place the restart positioning is walking him to: to that place (he stops there),
    // not led by his set-up walk. Still on a long walk: led by his run, as a click now would be.
    restartIntent(s, mate); // fills this tick's restart targets
    const place = s.aiRestart?.targets[mate.i];
    const r = place && dist(place, mate.pos) < RESTART_NEAR_PLACE ? passToPoint(s, mate, place) : passTo(s, mate);
    return { kind: 'pass', target: r.target, receiver: r.receiver, speed: r.speed };
  }
  const it = humanIntent(s, p, q.input);
  return isKick(it.action) ? it.action : null;
}

/** The men of a free-kick wall who are on their marks, or in the air from it: separate() leaves them where they are. */
function wallPlanted(s: MatchState): number[] {
  const w = s.wall;
  if (!w) return [];
  if (w.struck >= 0) return w.players;
  const t = s.aiRestart?.targets;
  if (!s.restart || s.restart.stage === 'whistle' || !t) return [];
  return w.players.filter((i) => !!t[i] && dist(s.players[i].pos, t[i]!) < WALL_FORMED);
}

/** A human taker this close to the ball at a free kick (m) may take it quickly, before the wall is formed. */
const QUICK_FREE_KICK_R = 1.5;

/** A wall's men are this close to their marks (m) when it counts as formed. */
const WALL_FORMED = 0.3;

/** The free-kick wall (if there is one) has formed: every man in it is on his mark, so the kick is ready. */
function wallFormed(s: MatchState): boolean {
  const w = s.wall;
  const t = s.aiRestart?.targets;
  if (!w || !t) return true;
  return w.players.every((i) => s.players[i].sentOff || !t[i] || dist(s.players[i].pos, t[i]!) < WALL_FORMED);
}

function setupLength(s: MatchState, r: Restart): number {
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
      return dist(r.spot, oppGoal(s, r.team)) < 32 ? 85 : 45;
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
  // A human side takes its own restarts, goal kicks through the keeper included.
  if (s.humans[r.team] && s.controlled[r.team] !== r.taker) {
    s.controlled[r.team] = r.taker;
    if (s.ctlHold) s.ctlHold[r.team] = true;
  }
  // Anyone still on the floor gets up.
  for (const p of s.players) {
    p.stun = Math.min(p.stun, 10);
    p.slide = null;
  }
}

/** How long a CPU taker stands over the ball before playing it (seeded). */
function restartWait(s: MatchState, r: Restart): number {
  const skill = clamp(s.teams[r.team].aiSkill, 0, 1);
  return r.kind === 'penalty' ? 45 : Math.round(14 + 22 * (1 - skill) + next(s.rng) * 14);
}

function beginReady(s: MatchState, r: Restart): void {
  r.stage = 'ready';
  r.ticks = 0;
  const t = s.players[r.taker];
  t.pos = takerSpot(s, r);
  t.vel = { x: 0, y: 0 };
  const face = norm(r.kind === 'throwin' ? { x: 0, y: r.spot.y < PITCH_H / 2 ? 1 : -1 } : sub(oppGoal(s, r.team), r.spot));
  if (len(face) > 0) t.facing = face;
  r.wait = restartWait(s, r);
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
      const humanCtl = isHumanControlled(s, p) && !heldByCpu(s, p, inputs[p.team]);
      const it = humanCtl ? humanIntent(s, p, inputs[p.team]) : restartIntent(s, p);
      movePlayer(s, p, { move: it.move, throttle: Math.min(it.throttle, 0.7) });
    }
    separate(s);
    updateBall(s, false);
    fixControlled(s);
    if (r.ticks >= (r.reason === 'foul' || r.reason === 'offside' ? RESTART_WHISTLE_FOUL : RESTART_WHISTLE)) beginSetup(s, r);
    return;
  }

  const b = s.ball;
  b.owner = r.taker;
  updateControl(s, 0, inputs[0]);
  updateControl(s, 1, inputs[1]);
  fixControlled(s);
  const taker = s.players[r.taker];
  const spot = takerSpot(s, r);
  const planted = wallPlanted(s);
  let kickAction: Action | null = null;
  for (const p of s.players) {
    if (p.sentOff) continue;
    const humanCtl = isHumanControlled(s, p);
    if (p === taker) {
      if (r.stage === 'setup') {
        const d = sub(spot, p.pos);
        const l = len(d);
        movePlayer(s, p, l < 0.2 ? IDLE_INTENT : { move: norm(d), throttle: Math.min(1, l / 1.5), sprint: l > 12 });
        // A human's click while he walks to the ball is kept and played the moment it is ready. Already over a
        // free kick, he may take it quickly (Law 13), before the wall is set: it is played now.
        if (humanCtl) {
          const input = inputs[p.team];
          const it = humanIntent(s, p, input);
          if (isKick(it.action)) {
            if (r.kind === 'freekick' && dist(p.pos, r.spot) < QUICK_FREE_KICK_R) kickAction = it.action;
            else r.queued = { input: { ...input, cursor: input.cursor && { ...input.cursor }, aim: input.aim && { ...input.aim } }, receiver: it.action.kind === 'pass' ? (it.action.receiver ?? -1) : -1 };
          }
        }
      } else {
        // Over the ball (or holding it): stays put until it is played.
        if (humanCtl && r.ticks < RESTART_HUMAN_WAIT) {
          const it = humanIntent(s, p, inputs[p.team]);
          if (isKick(it.action)) kickAction = it.action;
          else if (r.queued) kickAction = queuedRestartKick(s, p, r.queued);
          r.queued = null;
          if (it.throttle > 0.15) p.facing = norm(add(scale(p.facing, 0.8), scale(it.move, 0.2)));
        } else if (r.ticks >= r.wait) kickAction = restartAction(s, p);
        p.pos = { ...spot };
        p.vel = { x: 0, y: 0 };
      }
      continue;
    }
    // Law 8: everyone stays where they lined up until the kick-off is taken.
    if (r.kind === 'kickoff') continue;
    // A wall that has formed stands still until the kick.
    if (r.stage === 'ready' && planted.includes(p.i)) {
      p.vel = { x: 0, y: 0 };
      continue;
    }
    const it = humanCtl && !heldByCpu(s, p, inputs[p.team]) ? humanIntent(s, p, inputs[p.team]) : restartIntent(s, p);
    movePlayer(s, p, { move: it.move, throttle: it.throttle, sprint: it.sprint });
  }
  separate(s);
  enforceRestartPositions(s);
  b.pos = { ...r.spot };
  b.vel = { x: 0, y: 0 };
  b.z = restartBallZ(r);

  if (r.stage === 'setup' && kickAction) {
    // A quick free kick: from where the ball lies, the wall or no wall.
    taker.pos = { ...spot };
    taker.vel = { x: 0, y: 0 };
    takeRestart(s, taker, kickAction);
    fixControlled(s);
    return;
  }
  if (r.stage === 'setup') {
    const there = dist(taker.pos, spot) < 0.6;
    if ((there && r.ticks >= setupLength(s, r) && wallFormed(s)) || r.ticks >= RESTART_SETUP_MAX) beginReady(s, r);
    return;
  }
  if (kickAction) {
    takeRestart(s, taker, kickAction);
    fixControlled(s);
  }
}

/** The wall leaves the ground this many ticks after the strike, is in the air this long, and its feet rise this high (m). */
const WALL_JUMP_AFTER = 3;
const WALL_JUMP_TICKS = 32;
export const WALL_JUMP_Z = 0.45;

/**
 * A free-kick wall that has been shot at: its men stay where they stood and jump together as it is struck,
 * feet up to WALL_JUMP_Z (MatchPlayer.air; contacts lift their heads and bodies with them, so a ball driven
 * low can go under). Once they land the wall is gone and they play on.
 */
function wallJumps(s: MatchState, intents: Intent[]): void {
  const w = s.wall;
  if (!w || w.struck < 0) return;
  const t = s.tick - w.struck - WALL_JUMP_AFTER;
  const done = t >= WALL_JUMP_TICKS;
  for (const i of w.players) {
    const p = s.players[i];
    if (p.sentOff) continue;
    const u = clamp(t / WALL_JUMP_TICKS, 0, 1);
    p.air = done ? 0 : 4 * WALL_JUMP_Z * u * (1 - u);
    if (done) continue;
    intents[i] = IDLE_INTENT;
    p.vel = { x: 0, y: 0 };
  }
  if (done) s.wall = null;
}

/** Longest the whistle waits past added time for a shot in flight to finish (Law 7). */
const ADDED_HOLD_MAX = 4 * TICK_HZ;

/**
 * The clock runs through dead balls, as in a real match. At 45:00 and 90:00 the board goes
 * up and the added time is played with the clock held (Law 7); then the whistle waits for a
 * penalty to be taken, and for a shot already on its way to goal to finish.
 */
function runClock(s: MatchState): void {
  if (s.phase !== 'play' && s.phase !== 'restart') return;
  const a = s.added && s.added.half === s.half ? s.added : null;
  if (!a) {
    s.clock++;
    if (s.clock < s.halfTicks * s.half) return;
    const minutes = addedMinutes(s);
    s.added = { half: s.half, minutes, ticks: Math.round((minutes * s.halfTicks) / 45), elapsed: 0, hold: 0 };
    pushEvent(s, { kind: 'addedTime', ...eventBase(s, 0, -1), minutes });
    return;
  }
  if (a.elapsed < a.ticks) {
    a.elapsed++;
    return;
  }
  const penaltyPending = s.restart?.kind === 'penalty' || (s.phase === 'play' && s.ball.setPiece === 'penalty' && s.ball.owner < 0);
  if (penaltyPending) return;
  // Not while a shot is on its way, or a man is through on goal with it: the referee lets the
  // attack finish (a goal, a save, out of play, or the defence has it).
  const owner = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
  const through = !!owner && !s.ball.inHands && dist(owner.pos, oppGoal(s, owner.team)) < 20;
  if (s.phase === 'play' && a.hold < ADDED_HOLD_MAX && (goalBound(s, 0) || goalBound(s, 1) || through || !!s.advantage?.late)) {
    a.hold++;
    return;
  }
  s.restart = null;
  s.advantage = null;
  flushPendingCards(s);
  if (s.abandoned) return;
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
  applyTactics(s, input);
  moveReferee(s);
  if (s.phase === 'kickoff') {
    // Lined up: then the referee's whistle, and the kick-off is a restart like any other (Law 8):
    // the taker must kick it, the human taker included, and may not touch it again until someone else has.
    if (--s.phaseTicks <= 0 && s.restart) {
      s.phase = 'restart';
      const r = s.restart;
      r.ticks = 0;
      r.wait = restartWait(s, r);
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
  s.humanAim = [inputs[0].aim ?? inputs[0].cursor ?? null, inputs[1].aim ?? inputs[1].cursor ?? null];
  if (s.phase === 'restart') {
    // The clock starts with the kick-off (Law 8), not with the line-up.
    const kickoff = s.restart?.kind === 'kickoff';
    stepRestart(s, inputs);
    if (!kickoff) runClock(s);
    return;
  }

  updateControl(s, 0, inputs[0]);
  updateControl(s, 1, inputs[1]);
  fixControlled(s);
  const intents = s.players.map((p) => (p.sentOff ? IDLE_INTENT : isHumanControlled(s, p) ? humanOrTimeout(s, p, inputs[p.team]) : aiIntent(s, p)));
  wallJumps(s, intents);
  for (let i = 0; i < s.players.length && s.phase === 'play'; i++) applyAction(s, s.players[i], intents[i]);
  if (s.phase === 'play') keeperDives(s);
  s.players.forEach((p, i) => movePlayer(s, p, intents[i]));
  slideTackles(s);
  separate(s);
  updateBall(s, s.phase === 'play');
  if (s.phase === 'play') tickAdvantage(s);
  // The keeper let it go this tick: hand the human an outfielder now, not next tick. And
  // whoever took the ball this tick is the human's now, not next tick.
  fixControlled(s);
  const owner = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
  if (owner && s.humans[owner.team] && s.controlled[owner.team] !== owner.i) {
    s.controlled[owner.team] = owner.i;
    if (s.ctlHold) s.ctlHold[owner.team] = true;
  }

  const b = s.ball;
  if (b.owner >= 0 && b.inHands && s.players[b.owner].role === 'GK') b.handTicks = (b.handTicks ?? 0) + 1;
  else b.handTicks = 0;
  // Possession: live-ball ticks only, to the side that last controlled the ball (also while it travels between teammates).
  if (s.phase === 'play') {
    if (b.owner >= 0) s.poss = s.players[b.owner].team;
    if (s.poss === 0 || s.poss === 1) s.stats[s.poss].possessionTicks++;
  }
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
