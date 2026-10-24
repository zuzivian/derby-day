// The Laws of the Game as the sim applies them. Pure functions of the match
// state plus the seeded rng, like the rest of src/sim.
//
//   Law 8   kick-off                      resetKickoff in match.ts
//   Law 11  offside                       noteBallPlayed / offsideOnTouch
//   Law 12  fouls and misconduct          judgeFoul, issueCard, sendOff
//   Law 13  free kicks (direct/indirect)  awardRestart('freekick')
//   Law 14  penalty kick                  awardRestart('penalty')
//   Law 15  throw-in                      ballOut
//   Law 16  goal kick                     ballOut
//   Law 17  corner kick                   ballOut
//
// Restarts run a small state machine (types.ts Restart): 'whistle' (ball
// dead, still rolling), 'setup' (ball on the spot, taker walks up, everyone
// takes legal positions, which enforceRestartPositions guarantees), 'ready'
// (taker over the ball). match.ts steps it and takes the kick.
//
// The referee follows play on a diagonal. Whether a foul is given, and the
// cards, are seeded rolls whose odds depend on the severity of the foul and
// how far the referee is from it.

import {
  ADVANTAGE_TICKS,
  BOX_DEPTH,
  BOX_W,
  CORNER_R,
  DT,
  formationOf,
  GOAL_W,
  MATCH_SECONDS,
  PENALTY_SPOT,
  PITCH_H,
  PITCH_W,
  RETREAT,
  SIX_DEPTH,
  SIX_W,
  THROW_Z0,
} from './constants.ts';
import { attackDir, goalkeeper, inOffsidePosition, inOwnBox, inOwnSix, oppGoal, ownGoal, secondLastOpponentX, teamX } from './field.ts';
import { next } from './rng.ts';
import type {
  CardEvent,
  CardReason,
  FoulSeverity,
  MatchEvent,
  MatchPlayer,
  MatchState,
  Restart,
  RestartKind,
} from './types.ts';
import { add, clamp, dist, distToSegment, dot, len, norm, scale, sub, type Vec } from './vec.ts';

export type { RestartKind };

// ---------------------------------------------------------------------------
// Clock and events

export function matchMinute(s: MatchState): number {
  return Math.min(90, Math.floor((s.clock / (s.halfTicks * 2)) * 90) + 1);
}

/** Match clock in seconds on a 90-minute scale, 0..5400 (e.g. 1645 shows as 27:25). */
export function matchSeconds(s: MatchState): number {
  return Math.min(MATCH_SECONDS, Math.floor((s.clock / (s.halfTicks * 2)) * MATCH_SECONDS));
}

export function eventBase(s: MatchState, team: 0 | 1, player: number) {
  return { tick: s.tick, minute: matchMinute(s), second: matchSeconds(s), team, player };
}

export function pushEvent(s: MatchState, e: MatchEvent): void {
  s.events.push(e);
  if (e.kind === 'goal') s.goals.push(e);
  if (e.kind === 'card') s.cards.push(e);
}

const other = (t: 0 | 1): 0 | 1 => (t === 0 ? 1 : 0);

// ---------------------------------------------------------------------------
// Restarts

/** Restarts that can't produce an offside (Law 11). */
export const NO_OFFSIDE: ReadonlySet<RestartKind> = new Set(['throwin', 'goalkick', 'corner']);

const MID_Y = PITCH_H / 2;

/** Where the ball goes for this restart, given roughly where the offence or exit happened. */
export function restartSpot(kind: RestartKind, team: 0 | 1, at: Vec, direct: boolean): Vec {
  switch (kind) {
    case 'kickoff':
      return { x: PITCH_W / 2, y: MID_Y };
    case 'throwin':
      return { x: clamp(at.x, 0.5, PITCH_W - 0.5), y: at.y < MID_Y ? 0 : PITCH_H };
    case 'corner': {
      const gx = oppGoal(team).x;
      const inset = CORNER_R * 0.5;
      return { x: gx === 0 ? inset : PITCH_W - inset, y: at.y < MID_Y ? inset : PITCH_H - inset };
    }
    case 'goalkick': {
      const g = ownGoal(team);
      return { x: g.x + attackDir(team) * (SIX_DEPTH - 0.4), y: MID_Y + (at.y < MID_Y ? -1 : 1) * (SIX_W / 2 - 4.6) };
    }
    case 'penalty': {
      const g = oppGoal(team);
      return { x: g.x - attackDir(team) * PENALTY_SPOT, y: MID_Y };
    }
    case 'freekick': {
      let p = { x: clamp(at.x, 0.3, PITCH_W - 0.3), y: clamp(at.y, 0.3, PITCH_H - 0.3) };
      // Law 13: an indirect free kick to the attackers inside the goal area is
      // taken from the goal-area line nearest where the offence happened.
      const opp = other(team);
      if (!direct && inOwnSix(opp, p)) p = { x: ownGoal(opp).x + attackDir(opp) * SIX_DEPTH, y: p.y };
      return p;
    }
  }
  return { ...at };
}

/**
 * Stop play and set up a restart. `direct` matters for free kicks only (the
 * others follow their Law). Pending cards from an advantage are shown now.
 */
export function awardRestart(s: MatchState, kind: RestartKind, team: 0 | 1, at: Vec, reason: Restart['reason'], direct = true): void {
  if (kind === 'throwin') direct = false;
  else if (kind !== 'freekick') direct = true;
  const spot = restartSpot(kind, team, at, direct);
  const b = s.ball;
  b.owner = -1;
  b.receiver = -1;
  b.passFrom = -1;
  b.inHands = false;
  b.setPiece = null;
  b.kickedBy = -1;
  s.offside = null;
  s.advantage = null;
  s.restart = { kind, team, spot, taker: -1, stage: 'whistle', ticks: 0, direct, reason, wait: 0 };
  s.phase = 'restart';
  const st = s.stats[team];
  if (kind === 'corner') st.corners++;
  else if (kind === 'throwin') st.throwIns++;
  else if (kind === 'goalkick') st.goalKicks++;
  else if (kind === 'freekick') st.freeKicks++;
  else if (kind === 'penalty') st.penalties++;
  pushEvent(s, { kind: 'restart', ...eventBase(s, team, -1), restart: kind, spot: { ...spot }, direct, reason });
  flushPendingCards(s);
}

/** The ball has wholly crossed a touchline or goal line (not into the goal). */
export function ballOut(s: MatchState, at: Vec): void {
  const last = s.ball.lastTouch >= 0 ? s.players[s.ball.lastTouch] : null;
  const lastTeam: 0 | 1 = last ? last.team : 0;
  if (at.y < 0 || at.y > PITCH_H) {
    awardRestart(s, 'throwin', other(lastTeam), at, 'out');
    return;
  }
  // Goal line: whose?
  const defending: 0 | 1 = at.x < PITCH_W / 2 ? 0 : 1;
  if (lastTeam === defending) awardRestart(s, 'corner', other(defending), at, 'out');
  else awardRestart(s, 'goalkick', defending, at, 'out');
}

/** Pick who takes it: the CPU's choice, used for human sides too (a human then steers the taker if it isn't the keeper). */
export function chooseTaker(s: MatchState, r: Restart): number {
  const team = r.team;
  const mates = s.players.filter((p) => p.team === team && !p.sentOff);
  const outfield = mates.filter((p) => p.role !== 'GK');
  const pool = outfield.length ? outfield : mates;
  const gk = goalkeeper(s, team);
  const best = (cost: (p: MatchPlayer) => number, from = pool) => from.reduce((a, b) => (cost(b) < cost(a) ? b : a)).i;
  switch (r.kind) {
    case 'goalkick':
      return gk.i;
    case 'penalty':
      return best((p) => -p.attrs.shooting - 0.2 * p.attrs.dribbling);
    case 'throwin':
      return best((p) => dist(p.pos, r.spot) - (p.sub === 'FB' || p.sub === 'WM' || p.sub === 'W' ? 6 : 0) + (p.sub === 'CB' || p.sub === 'ST' ? 6 : 0));
    case 'corner': {
      const wide = pool.filter((p) => p.sub !== 'CB' && p.sub !== 'ST');
      return best((p) => dist(p.pos, r.spot) * 0.35 - p.attrs.passing * 22, wide.length ? wide : pool);
    }
    case 'freekick': {
      if (inOwnBox(team, r.spot)) return gk.i;
      if (r.direct && dist(r.spot, oppGoal(team)) < 30) return best((p) => -p.attrs.shooting * 30 - p.attrs.passing * 8 + dist(p.pos, r.spot) * 0.15);
      return best((p) => dist(p.pos, r.spot) - (p.role === 'DEF' && teamX(team, r.spot.x) < 0.3 ? 3 : 0));
    }
    case 'kickoff':
      return best((p) => (p.role === 'FWD' ? 0 : 10) + p.slot * 0.1);
  }
}

/** Where the taker stands to take it. */
export function takerSpot(r: Restart): Vec {
  if (r.kind === 'throwin') return { x: r.spot.x, y: r.spot.y + (r.spot.y < MID_Y ? -0.45 : 0.45) };
  const dir = r.kind === 'goalkick' ? norm({ x: attackDir(r.team), y: 0 }) : norm(sub(oppGoal(r.team), r.spot));
  const d = len(dir) > 0 ? dir : { x: attackDir(r.team), y: 0 };
  return sub(r.spot, scale(d, 0.75));
}

/** Ball height while it waits for the restart (a throw-in is held above the head). */
export const restartBallZ = (r: Restart): number => (r.kind === 'throwin' && r.stage === 'ready' ? THROW_Z0 : 0);

function pushOut(p: MatchPlayer, centre: Vec, radius: number): void {
  const d = sub(p.pos, centre);
  const l = len(d);
  if (l >= radius) return;
  const n = l > 1e-6 ? scale(d, 1 / l) : { x: -attackDir(p.team), y: 0 };
  p.pos = add(centre, scale(n, radius + 0.02));
}

/** Push a point out of `team`'s penalty area, through its nearest edge. */
function outOfBox(p: MatchPlayer, team: 0 | 1): void {
  if (!inOwnBox(team, p.pos)) return;
  const g = ownGoal(team);
  const depth = teamX(team, p.pos.x) * PITCH_W;
  const toFront = BOX_DEPTH - depth;
  const toSide = BOX_W / 2 - Math.abs(p.pos.y - MID_Y);
  if (toFront <= toSide) p.pos = { x: g.x + attackDir(team) * (BOX_DEPTH + 0.3), y: p.pos.y };
  else p.pos = { x: p.pos.x, y: MID_Y + Math.sign(p.pos.y - MID_Y || 1) * (BOX_W / 2 + 0.3) };
}

/**
 * Hard limits during a restart (applied every tick of setup and ready, and to
 * humans too): the referee keeps opponents at the required distance.
 */
export function enforceRestartPositions(s: MatchState): void {
  const r = s.restart;
  if (!r || r.stage === 'whistle') return;
  for (const p of s.players) {
    if (p.sentOff || p.i === r.taker) continue;
    const opp = p.team !== r.team;
    switch (r.kind) {
      case 'kickoff':
        // Own half; the opponents also outside the centre circle.
        if (teamX(p.team, p.pos.x) > 0.5 - 0.3 / PITCH_W) p.pos = { x: PITCH_W / 2 - attackDir(p.team) * 0.3, y: p.pos.y };
        if (opp) pushOut(p, r.spot, RETREAT);
        break;
      case 'throwin':
        if (opp) pushOut(p, r.spot, 2);
        break;
      case 'goalkick':
        if (opp) outOfBox(p, r.team);
        break;
      case 'corner':
        if (opp) pushOut(p, r.spot, RETREAT);
        break;
      case 'freekick': {
        if (!opp) break;
        // Defenders may stand on their own goal line between the posts for an indirect kick close in.
        const g = ownGoal(p.team);
        const onLine = Math.abs(p.pos.x - g.x) < 0.6 && Math.abs(p.pos.y - MID_Y) < GOAL_W / 2;
        if (!onLine) pushOut(p, r.spot, RETREAT);
        if (inOwnBox(r.team, r.spot)) outOfBox(p, r.team); // a free kick in its own area: opponents outside it
        break;
      }
      case 'penalty': {
        const defGk = goalkeeper(s, other(r.team));
        if (p.i === defGk.i) {
          // On the goal line between the posts until it is kicked.
          const g = ownGoal(p.team);
          p.pos = { x: g.x + attackDir(p.team) * 0.15, y: clamp(p.pos.y, MID_Y - GOAL_W / 2 + 0.5, MID_Y + GOAL_W / 2 - 0.5) };
          break;
        }
        // Everyone else: outside the area, behind the mark, and 9.15 m from it.
        const defTeam = other(r.team);
        outOfBox(p, defTeam);
        pushOut(p, r.spot, RETREAT);
        const behind = teamX(r.team, r.spot.x) - 0.3 / PITCH_W;
        if (teamX(r.team, p.pos.x) > behind) p.pos = { x: r.team === 0 ? behind * PITCH_W : (1 - behind) * PITCH_W, y: p.pos.y };
        outOfBox(p, defTeam);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Offside (Law 11)

/**
 * A player has just played the ball: remember which teammates were in an
 * offside position at that moment. Being there is no offence; becoming
 * involved (touching the ball) is, checked in offsideOnTouch.
 */
export function noteBallPlayed(s: MatchState, p: MatchPlayer): void {
  const second = secondLastOpponentX(s, p.team);
  const flagged: number[] = [];
  for (const m of s.players) {
    if (m.team !== p.team || m.i === p.i || m.sentOff) continue;
    if (inOffsidePosition(s, m, s.ball.pos.x, second)) flagged.push(m.i);
  }
  s.offside = flagged.length ? { team: p.team, tick: s.tick, players: flagged } : null;
}

/**
 * Player p is about to touch the ball. Returns true if that is an offside
 * offence (and the indirect free kick has been awarded). A deliberate play
 * by an opponent resets the judgement; a deflection or save does not.
 */
export function offsideOnTouch(s: MatchState, p: MatchPlayer, deliberate: boolean): boolean {
  const w = s.offside;
  if (!w) return false;
  if (p.team !== w.team) {
    if (deliberate) s.offside = null;
    return false;
  }
  if (w.players.includes(p.i)) {
    const at = { ...p.pos };
    s.stats[p.team].offsides++;
    pushEvent(s, { kind: 'offside', ...eventBase(s, p.team, p.i), spot: at });
    awardRestart(s, 'freekick', other(p.team), at, 'offside', false);
    return true;
  }
  // An onside teammate has it: the old positions no longer matter.
  s.offside = null;
  return false;
}

// ---------------------------------------------------------------------------
// Fouls and misconduct (Law 12)

export interface FoulContext {
  offender: MatchPlayer;
  victim: MatchPlayer;
  severity: FoulSeverity;
  /** A genuine attempt to play the ball (not a late or off-the-ball challenge). */
  attempt: boolean;
  /** Does the victim's team still have the ball after the challenge? */
  keptBall: boolean;
}

/** Denying an obvious goal-scoring opportunity: through on goal with no covering defender but the keeper. */
export function isDogso(s: MatchState, victim: MatchPlayer, offender: MatchPlayer): boolean {
  const goal = oppGoal(victim.team);
  const d = dist(victim.pos, goal);
  if (d > 25) return false;
  const towards = dot(norm(sub(goal, victim.pos)), norm(len(victim.vel) > 0.5 ? victim.vel : victim.facing));
  if (towards < 0.2) return false;
  // Wide on the byline is not obvious.
  if (Math.abs(victim.pos.y - MID_Y) > 16 && teamX(victim.team, victim.pos.x) > 0.9) return false;
  const vx = teamX(victim.team, victim.pos.x);
  for (const m of s.players) {
    if (m.team === victim.team || m.sentOff || m.i === offender.i || m.role === 'GK') continue;
    if (teamX(victim.team, m.pos.x) > vx - 0.01 && distToSegment(m.pos, victim.pos, goal) < 5) return false;
  }
  return true;
}

/** Stopping a promising attack: a carry into the attacking third with few defenders goal-side. */
export function isSpa(s: MatchState, victim: MatchPlayer, offender: MatchPlayer): boolean {
  const vx = teamX(victim.team, victim.pos.x);
  if (vx < 0.58) return false;
  const goal = oppGoal(victim.team);
  let goalSide = 0;
  for (const m of s.players) {
    if (m.team === victim.team || m.sentOff || m.i === offender.i || m.role === 'GK') continue;
    if (teamX(victim.team, m.pos.x) > vx && distToSegment(m.pos, victim.pos, goal) < 9) goalSide++;
  }
  return goalSide <= 1;
}

/** How likely the referee is to see and give it. */
function whistleChance(s: MatchState, at: Vec, severity: FoulSeverity): number {
  const base = severity === 'excessive' ? 1 : severity === 'reckless' ? 0.97 : 0.84;
  const view = clamp(1.06 - dist(s.referee.pos, at) / 90, 0.75, 1);
  return base * view;
}

/**
 * A challenge was a foul. The referee decides (seeded) whether to give it,
 * whether to play advantage, the free kick or penalty, and any card.
 * Returns true if play was stopped (the caller should stop acting this tick).
 */
export function judgeFoul(s: MatchState, f: FoulContext): boolean {
  const { offender, victim, severity } = f;
  const at = { ...victim.pos };
  if (next(s.rng) >= whistleChance(s, at, severity)) return false;
  const victimTeam = victim.team;
  const penalty = inOwnBox(offender.team, at);
  const dogso = isDogso(s, victim, offender);
  const spa = !dogso && isSpa(s, victim, offender);
  // Advantage: the fouled side kept the ball in a good attacking position. Never for a penalty.
  const advantage = !penalty && f.keptBall && teamX(victimTeam, at.x) > 0.45 && severity !== 'excessive' && next(s.rng) < 0.8;

  s.stats[offender.team].fouls++;
  pushEvent(s, { kind: 'foul', ...eventBase(s, offender.team, offender.i), victim: victim.i, spot: at, severity, penalty, advantage });

  // Misconduct.
  const cards: { color: 'yellow' | 'red'; reason: CardReason }[] = [];
  const roll = next(s.rng);
  if (severity === 'excessive') cards.push(roll < 0.88 ? { color: 'red', reason: 'excessive' } : { color: 'yellow', reason: 'reckless' });
  else if (dogso) {
    // Law 12: in the penalty area a genuine attempt at the ball is a caution, and so is DOGSO when advantage is played.
    if ((penalty && f.attempt) || advantage) cards.push({ color: 'yellow', reason: 'dogso' });
    else if (roll < 0.9) cards.push({ color: 'red', reason: 'dogso' });
    else cards.push({ color: 'yellow', reason: 'dogso' });
  } else if (severity === 'reckless') {
    if (roll < 0.86) cards.push({ color: 'yellow', reason: 'reckless' });
  } else if (spa && !advantage && !(penalty && f.attempt)) {
    if (roll < 0.75) cards.push({ color: 'yellow', reason: 'spa' });
  }

  if (advantage) {
    for (const c of cards) s.pendingCards.push({ player: offender.i, color: c.color, reason: c.reason });
    s.advantage = { team: victimTeam, until: s.tick + ADVANTAGE_TICKS, spot: at, penalty: false };
    pushEvent(s, { kind: 'advantage', ...eventBase(s, victimTeam, victim.i), spot: at });
    return false;
  }
  for (const c of cards) issueCard(s, offender, c.color, c.reason);
  if (penalty) awardRestart(s, 'penalty', victimTeam, at, 'foul');
  else awardRestart(s, 'freekick', victimTeam, at, 'foul', true);
  victim.stun = Math.max(victim.stun, 30);
  return true;
}

/** Each tick of play during an advantage: call it back if the fouled side lost the ball. */
export function tickAdvantage(s: MatchState): void {
  const a = s.advantage;
  if (!a) return;
  const owner = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
  if (owner && owner.team !== a.team) {
    s.advantage = null;
    awardRestart(s, 'freekick', a.team, a.spot, 'foul', true);
    return;
  }
  if (s.tick >= a.until) s.advantage = null;
}

/** Show cards held back while advantage was played. Called at every stoppage. */
export function flushPendingCards(s: MatchState): void {
  const cards = s.pendingCards;
  if (!cards.length) return;
  s.pendingCards = [];
  for (const c of cards) {
    const p = s.players[c.player];
    if (!p.sentOff) issueCard(s, p, c.color, c.reason);
  }
}

/** A goal was scored while an advantage card was pending: DOGSO red becomes a caution (Law 12). */
export function downgradeDogso(s: MatchState): void {
  for (const c of s.pendingCards) if (c.reason === 'dogso') c.color = 'yellow';
}

export function issueCard(s: MatchState, p: MatchPlayer, color: 'yellow' | 'red', reason: CardReason): void {
  if (p.sentOff) return;
  const card = (c: 'yellow' | 'red', r: CardReason, secondYellow: boolean): CardEvent => ({ kind: 'card', ...eventBase(s, p.team, p.i), color: c, name: p.name, secondYellow, reason: r });
  if (color === 'yellow') {
    p.yellow++;
    s.stats[p.team].yellows++;
    const second = p.yellow >= 2;
    pushEvent(s, card('yellow', reason, second));
    if (!second) return;
    s.stats[p.team].reds++;
    pushEvent(s, card('red', 'second-yellow', true));
  } else {
    s.stats[p.team].reds++;
    pushEvent(s, card('red', reason, false));
  }
  sendOff(s, p);
}

/** Where a player who has been sent off is parked: well outside the pitch, out of every calculation. */
export const OFF_PITCH: Vec = { x: PITCH_W / 2, y: -60 };

export function sendOff(s: MatchState, p: MatchPlayer): void {
  p.sentOff = true;
  pushEvent(s, { kind: 'sentOff', ...eventBase(s, p.team, p.i), name: p.name });
  const b = s.ball;
  if (b.owner === p.i) {
    b.owner = -1;
    b.inHands = false;
  }
  if (b.receiver === p.i) b.receiver = -1;
  p.pos = { ...OFF_PITCH };
  p.vel = { x: 0, y: 0 };
  p.stun = 0;
  if (p.role === 'GK') {
    // No substitutes: the deepest defender goes in goal.
    const mates = s.players.filter((m) => m.team === p.team && !m.sentOff);
    const order = (m: MatchPlayer) => (m.role === 'DEF' ? 0 : m.role === 'MID' ? 1 : 2) - m.attrs.goalkeeping;
    const sub = mates.sort((a, c) => order(a) - order(c))[0];
    if (sub) {
      sub.role = 'GK';
      sub.sub = 'GK';
    }
  }
  if (s.restart && s.restart.taker === p.i) s.restart.taker = chooseTaker(s, s.restart);
  fixControlled(s);
}

/**
 * A human must never steer a player who is off the pitch, or a keeper except while the
 * keeper has the ball, it is on its way to him, or he is taking a restart (human.ts
 * keeperControllable: the human distributes it, not the CPU).
 */
export function fixControlled(s: MatchState): void {
  for (const team of [0, 1] as const) {
    if (!s.humans[team]) continue;
    const cur = s.players[s.controlled[team]];
    const keeperOk = (p: MatchPlayer) =>
      s.ball.owner === p.i || (s.ball.owner < 0 && s.ball.receiver === p.i) || (!!s.restart && s.restart.taker === p.i && s.restart.stage !== 'whistle');
    if (cur && !cur.sentOff && cur.team === team && (cur.role !== 'GK' || keeperOk(cur))) continue;
    const cands = s.players.filter((m) => m.team === team && !m.sentOff && m.role !== 'GK');
    if (!cands.length) continue;
    cands.sort((a, b) => dist(a.pos, s.ball.pos) - dist(b.pos, s.ball.pos));
    s.controlled[team] = cands[0].i;
    // An automatic change: he holds until the pointer moves (MatchState.ctlHold, human.ts).
    if (s.ctlHold) s.ctlHold[team] = true;
  }
}

// ---------------------------------------------------------------------------
// Referee

/**
 * The referee runs the diagonal: stays 10-20 m from the ball, toward the line
 * from one corner to the other, so play is seen side-on and he is out of
 * passing lanes. Jogging speed, quicker when play is far away.
 */
export function moveReferee(s: MatchState): void {
  const ref = s.referee;
  const r = s.restart;
  const ball = r && r.stage !== 'whistle' ? r.spot : s.ball.pos;
  const diag = { x: ball.x, y: 10 + (PITCH_H - 20) * clamp(ball.x / PITCH_W, 0, 1) };
  let away = sub(diag, ball);
  if (len(away) < 4) away = { x: -attackDir(s.ball.owner >= 0 ? s.players[s.ball.owner].team : 0) * 6, y: ball.y < MID_Y ? 8 : -8 };
  let target = add(ball, scale(norm(away), r?.kind === 'penalty' ? 14 : 13));
  if (r && r.stage !== 'whistle' && (r.kind === 'corner' || r.kind === 'freekick')) {
    // Stand where the drop zone and the wall are both in view.
    const g = oppGoal(r.team);
    target = add(add(g, scale(sub(r.spot, g), 0.55)), { x: -attackDir(r.team) * 6, y: ball.y < MID_Y ? 12 : -12 });
  }
  target = { x: clamp(target.x, 2, PITCH_W - 2), y: clamp(target.y, 2, PITCH_H - 2) };
  const to = sub(target, ref.pos);
  const d = len(to);
  const top = d > 20 ? 7.5 : d > 6 ? 5.5 : 3;
  const want = d < 0.4 ? { x: 0, y: 0 } : scale(norm(to), Math.min(top, d * 1.2));
  const dv = sub(want, ref.vel);
  const acc = 9 * DT;
  ref.vel = len(dv) <= acc ? want : add(ref.vel, scale(norm(dv), acc));
  ref.pos = add(ref.pos, scale(ref.vel, DT));
  // Face the ball.
  const look = sub(ball, ref.pos);
  if (len(look) > 0.5) ref.facing = norm(look);
}

/** Which slot labels exist, for the given team. */
export const slotsFor = (s: MatchState, team: 0 | 1) => formationOf(s.teams[team].formation);
