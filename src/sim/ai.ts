// CPU behaviour for every player the human isn't steering. It reads the match
// state and returns an Intent; it never mutates anything except per-player
// timers and memory, the team plans and the shared RNG, so it runs
// identically on client and server.
//
// Structure:
//   teamPlan()       per team, every 1-5 ticks: who chases the ball, who marks
//                    whom, where each player can intercept a loose ball, how
//                    high the back line holds (it steps up to play offside).
//   shapeTarget()    eleven-a-side positional play in the team's formation:
//                    a back four that holds a line, full-backs that overlap on
//                    the ball side, a holding midfielder screening the centre
//                    backs, wide players and strikers who stay onside.
//   ownerIntent()    the ball carrier: shoot, chip, cross, pass (to feet,
//                    through ball, switch), carry, take a man on, shield, clear.
//   supportTarget()  off-ball attackers: runs on the last line, wide channels,
//                    box positions for a cross, short options, rest defence.
//   defendIntent()   press, mark goal-side (defenders don't drop off the line),
//                    step in to intercept, screen.
//   gkIntent()       angle play, sweeping, shot reaction, penalty dives,
//                    distribution.
//   restartIntent()  positions for set pieces (box runs and marking at
//                    corners, walls at free kicks, the penalty arc...), and
//   restartAction()  what a CPU taker does with a throw-in, goal kick, corner,
//                    free kick or penalty.
//
// Difficulty (TeamSetup.aiSkill, 0..1) scales:
//   reaction  how stale the plan is (rebuilt every 1 tick at skill 1, every
//             5 at skill 0) and how far behind the ball the team "sees" it;
//   decisions how often players re-decide and how much noise is added to
//             pass, shot and positioning scores; how well passers spot a
//             receiver in an offside position and how carefully runners
//             keep onside;
//   execution extra drift on passes and shots on top of attribute error;
//   defending how wide the marking zone is, how readily markers step in to
//             intercept, how tidy the back line is, how far the keeper sweeps.
// scripts/ai-probe.ts measures it with equal squads. Tuning numbers below were
// chosen with that and scripts/balance.ts; change them with both to hand.

import {
  AIR_DRAG,
  BOX_DEPTH,
  BOX_W,
  GOAL_BOTTOM,
  GOAL_TOP,
  GOAL_W,
  GRAVITY,
  HEAD_Z,
  KEEPER_REACH_Z,
  PITCH_H,
  PITCH_W,
  REACH_Z,
  RETREAT,
  SPRINT_MULT,
  TICK_HZ,
  type Mentality,
  type SubRole,
} from './constants.ts';
import {
  attackDir,
  clampToPitch,
  fromTeam,
  goalkeeper,
  inOffsidePosition,
  inOwnBox,
  oppGoal,
  ownGoal,
  secondLastOpponentX,
  slotOf,
  teamX,
} from './field.ts';
import { chipPlan, rollTravel } from './kicks.ts';
import { chance, gauss, next, range } from './rng.ts';
import type { Action, AiInterception, AiMemory, AiTeamPlan, Intent, MatchPlayer, MatchState, Restart } from './types.ts';
import { add, clamp, dot, rotate, scale, sub, type Vec } from './vec.ts';
import { barredSecondTouch } from './rules.ts';

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
const dist2 = (a: Vec, b: Vec): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * The (up to) k items with the smallest key, nearest first, in one pass: no filter, sort or
 * copies (these run on every team plan). A null key, or one at or above `below`, leaves it out.
 */
function nearestK<T>(items: readonly T[], k: number, key: (t: T) => number | null, below = Infinity): T[] {
  const out: T[] = [];
  const keys: number[] = [];
  if (k <= 0) return out;
  for (const t of items) {
    const v = key(t);
    if (v === null || v >= below || (out.length === k && v >= keys[k - 1])) continue;
    let at = out.length;
    while (at > 0 && keys[at - 1] > v) at--;
    out.splice(at, 0, t);
    keys.splice(at, 0, v);
    if (out.length > k) {
      out.pop();
      keys.pop();
    }
  }
  return out;
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
const SHOOT_XG = 0.011;
/**
 * From outside the box how keen a side is to shoot is its mentality's call (Tactic.shootLong):
 * Balanced shoots as the CPU always has; Park the bus waits for a better look, Attacking and
 * High press have a go more often. scripts/balance.ts prints shots and goals by distance.
 */
const LONG_SHOT_FROM = 18;
/** A shot in flight longer than GK_TIME_FROM s lets him get further across, fully in line GK_TIME_SPAN s later. */
const GK_TIME_FROM = 0.4;
const GK_TIME_SPAN = 0.6;
/** A metre in team-x units. */
const M = 1 / PITCH_W;

// ---------------------------------------------------------------------------
// Tactics. A team's mentality (TeamSetup.mentality) is a set of knobs on the
// behaviour below. Balanced is the CPU as it played before mentalities
// existed; the others move every knob one way or the other. Distances along
// the pitch are in team-x units (0 own goal line .. 1 theirs, 0.01 is about
// a metre). scripts/tactics-probe.ts measures what each one does.

export interface Tactic {
  /** Out of possession, how far the back line sits behind the ball (unpressured; 0.05 less when the carrier is pressed). */
  lineGap: number;
  /** ...and the band it holds in: never deeper than lineMin, never higher than lineMax. */
  lineMin: number;
  lineMax: number;
  /** Near our own box the line holds at this height (the edge of the area) rather than dropping onto the keeper. */
  boxHold: number;
  /** In possession: the back line sits attGap behind the ball, between attMin and attMax. */
  attGap: number;
  attMin: number;
  attMax: number;
  /** Out of possession: width of the block (1 = the formation's width), pull toward the ball side, and how far midfield and attack stand ahead of the line (1 = normal). */
  defWidth: number;
  squeeze: number;
  defDepth: number;
  /** In possession: width and how far ahead of the line the shape pushes. */
  attWidth: number;
  attDepth: number;
  /** The chaser goes in on the carrier when the ball is within pressUpTo of our goal line (1 = anywhere), or when the carrier comes within pressNear metres; otherwise he holds off goal-side. */
  pressUpTo: number;
  pressNear: number;
  /** Extra players who press with the chaser (cutting passing lanes, doubling up) once the ball is beyond extraFrom (our team-x). */
  extra: number;
  extraFrom: number;
  /** How far a defender leaves his zone to pick up a man (1 = normal). */
  markR: number;
  /** Screening: when the carrier is within screenR m of our goal, this many players step into the line between him and it. */
  screen: number;
  screenR: number;
  /** Counter-press: for this many ticks after losing the ball, counterN more players hunt it and the line holds up. */
  counter: number;
  counterN: number;
  /** The ball-side full-back overlaps once the ball is beyond fbUp (above 1: never); farFbUp pushes the far one on too instead of tucking in. */
  fbUp: number;
  farFbUp: boolean;
  /** Wing-backs in possession: 0 hold the line, 1 the ball-side one goes, 2 both give width high up. */
  wbUp: 0 | 1 | 2;
  /** Who gets into the box for a cross and runs in behind: 0 strikers, 1 and wingers, 2 and central midfielders, 3 and attacking and wide midfielders. */
  boxRunners: 0 | 1 | 2 | 3;
  /** Pass choice: weight on how far forward a pass goes against how safe it is (1 = normal). */
  risk: number;
  /** Carrier decision interval (below 1 is quicker), how fast patience runs out, how much he likes to carry it. */
  tempo: number;
  urgency: number;
  carry: number;
  /** How keen the side is to shoot from outside the box (1 = normal; scales the chance it needs). */
  shootLong: number;
  /** Readiness to clear it long when pressed deep in our half (added to the pass score below which he clears). */
  clear: number;
  /** Direct play: the chance, on each decision in our own half, of hitting a long ball up to a forward instead of building up. */
  direct: number;
  /** Tackling: chance multiplier and extra reach (m). Keener tackling wins it higher and gives away more fouls. */
  tackle: number;
  reach: number;
  /** Teammates who come to offer the carrier a short pass, and how far from him (m). */
  supporters: number;
  supportR: number;
  /** Throttle when jogging back into shape from far away. */
  recover: number;
}

export const TACTICS: Record<Mentality, Tactic> = {
  park: {
    lineGap: 0.22, lineMin: 0.08, lineMax: 0.26, boxHold: 0.17, attGap: 0.4, attMin: 0.1, attMax: 0.3,
    defWidth: 0.66, squeeze: 0.26, defDepth: 0.6, attWidth: 1, attDepth: 0.78,
    pressUpTo: 0.34, pressNear: 3.5, extra: 0, extraFrom: 2, markR: 0.75, screen: 2, screenR: 32, counter: 0, counterN: 0,
    fbUp: 2, farFbUp: false, wbUp: 0, boxRunners: 0,
    risk: 0.75, tempo: 1.1, urgency: 0.6, carry: 1.15, shootLong: 0.7, clear: 0.8, direct: 0.5, tackle: 0.85, reach: 0,
    supporters: 2, supportR: 11, recover: 0.95,
  },
  defensive: {
    lineGap: 0.23, lineMin: 0.06, lineMax: 0.34, boxHold: 0.16, attGap: 0.34, attMin: 0.12, attMax: 0.42,
    defWidth: 0.74, squeeze: 0.28, defDepth: 0.7, attWidth: 1.04, attDepth: 0.9,
    pressUpTo: 0.4, pressNear: 4, extra: 0, extraFrom: 2, markR: 0.8, screen: 2, screenR: 32, counter: 0, counterN: 0,
    fbUp: 0.6, farFbUp: false, wbUp: 1, boxRunners: 2,
    risk: 0.88, tempo: 1.05, urgency: 0.8, carry: 1.05, shootLong: 0.85, clear: 0.4, direct: 0.15, tackle: 0.95, reach: 0,
    supporters: 2, supportR: 10, recover: 0.85,
  },
  balanced: {
    lineGap: 0.24, lineMin: 0.05, lineMax: 0.42, boxHold: 0.15, attGap: 0.3, attMin: 0.14, attMax: 0.52,
    defWidth: 0.8, squeeze: 0.3, defDepth: 1, attWidth: 1.08, attDepth: 1,
    pressUpTo: 1, pressNear: 99, extra: 0, extraFrom: 2, markR: 1, screen: 0, screenR: 0, counter: 0, counterN: 0,
    fbUp: 0.4, farFbUp: false, wbUp: 2, boxRunners: 2,
    risk: 1, tempo: 1, urgency: 1, carry: 1, shootLong: 1, clear: 0, direct: 0, tackle: 1, reach: 0,
    supporters: 3, supportR: 10, recover: 0.7,
  },
  attacking: {
    lineGap: 0.21, lineMin: 0.08, lineMax: 0.48, boxHold: 0.15, attGap: 0.27, attMin: 0.18, attMax: 0.58,
    defWidth: 0.84, squeeze: 0.32, defDepth: 1.08, attWidth: 1.12, attDepth: 1.08,
    pressUpTo: 1, pressNear: 99, extra: 1, extraFrom: 0.55, markR: 1, screen: 0, screenR: 0, counter: 90, counterN: 1,
    fbUp: 0.3, farFbUp: true, wbUp: 2, boxRunners: 3,
    risk: 1.2, tempo: 0.9, urgency: 1.25, carry: 0.95, shootLong: 1.15, clear: -0.3, direct: 0, tackle: 1.1, reach: 0.1,
    supporters: 3, supportR: 10, recover: 0.75,
  },
  press: {
    lineGap: 0.17, lineMin: 0.12, lineMax: 0.56, boxHold: 0.16, attGap: 0.25, attMin: 0.22, attMax: 0.6,
    defWidth: 0.8, squeeze: 0.4, defDepth: 0.95, attWidth: 1.1, attDepth: 1.02,
    pressUpTo: 1, pressNear: 99, extra: 2, extraFrom: 0.38, markR: 1.15, screen: 0, screenR: 0, counter: 180, counterN: 2,
    fbUp: 0.32, farFbUp: true, wbUp: 2, boxRunners: 3,
    risk: 1.25, tempo: 0.85, urgency: 1.3, carry: 0.9, shootLong: 1.15, clear: -0.3, direct: 0, tackle: 1.2, reach: 0.2,
    supporters: 3, supportR: 9, recover: 0.9,
  },
};

/** A team's tactic (called many times a tick, so a plain lookup; an unknown mentality plays Balanced). */
export const tacticOf = (s: MatchState, team: 0 | 1): Tactic => TACTICS[s.teams[team].mentality ?? 'balanced'] ?? TACTICS.balanced;

/** Where each sub-role stands in the formations it was tuned on; a slot higher or deeper than this shifts the player with it (a 4-2-3-1's wingers drop deeper than a 4-3-3's). */
const CANON_X: Record<SubRole, number> = { GK: 0.02, CB: 0.18, FB: 0.2, WB: 0.22, DM: 0.34, CM: 0.41, AM: 0.49, WM: 0.4, W: 0.58, ST: 0.59 };
/** Box runners at each tactic level (Tactic.boxRunners). */
const RUNNERS: SubRole[][] = [['ST'], ['ST', 'W'], ['ST', 'W', 'CM'], ['ST', 'W', 'CM', 'AM', 'WM']];
const runsIntoBox = (k: Tactic, sub: SubRole): boolean => RUNNERS[k.boxRunners].includes(sub);

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
    // Kickoff, restart or a pause: drop anything stale.
    m.target = null;
    m.retarget = 0;
    if (m.mode !== 'dive') m.mode = 'none';
  }
  m.lastTick = s.tick;
  return m;
}

/**
 * Does this player know he is offside right now? A stable, deterministic
 * coin per player and second (no rng draw), weighted by skill: sharp sides
 * nearly always know, sloppy ones sometimes play on regardless.
 */
function offsideAware(s: MatchState, m: MatchPlayer): boolean {
  const k = (Math.imul(m.i + 7, 2654435761) ^ Math.floor(s.tick / 60)) >>> 0;
  return (k % 100) / 100 < 0.05 + 0.45 * skillOf(s, m.team);
}

// ---------------------------------------------------------------------------
// Ball prediction. Mirrors the rolling and flight model in match.ts
// updateBall (rollTravel in kicks.ts integrates the rolling part exactly).

const ballTravel = rollTravel;

const TRAJ_DT = 0.08;
const TRAJ_STEPS = 44; // about 3.5 s

interface Trajectory {
  pts: Vec[];
  /** Height at each step; 0 once the ball is back on the floor. */
  z: number[];
  v0: number;
}

/**
 * Predicted ball positions every TRAJ_DT seconds. A lofted ball flies with
 * light drag until it lands (match.ts: gravity, AIR_DRAG, then a damped
 * bounce), then rolls with floor friction. There are no boards: points past
 * a line are kept just outside it (the ball will be out of play there).
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
    pts[k] = { x: clamp(pos.x + dx * d, -0.5, PITCH_W + 0.5), y: clamp(pos.y + dy * d, -0.5, PITCH_H + 0.5) };
  }
  return { pts, z: zs, v0 };
}

function interceptOn(s: MatchState, p: MatchPlayer, traj: Trajectory): AiInterception {
  const { pts, z, v0 } = traj;
  if (p.sentOff) return { t: 1e9, pt: pts[0] };
  const sp = runSpeed(p) * (p.winded ? 1 : SPRINT_MULT * 0.97);
  const keeper = p.role === 'GK' && inOwnBox(s, p.team, p.pos);
  const reach = keeper ? 1.2 + 0.5 * p.attrs.goalkeeping : 0.9;
  const maxZ = keeper ? KEEPER_REACH_Z : REACH_Z;
  const blocked = (s.ball.noPickup[p.i] + p.stun) / 60;
  for (let k = 0; k < TRAJ_STEPS; ) {
    const t = k * TRAJ_DT;
    // Outfielders can also meet a dropping ball with their head.
    const reachZ = keeper ? maxZ : k > 0 && z[k] < z[k - 1] ? HEAD_Z : maxZ;
    if (t < blocked || z[k] > reachZ) {
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

/**
 * Is this player flagged offside by the last pass, and aware of it? Such a
 * player keeps out of play when the ball goes to someone else. The man it
 * was played to always goes for it: the flag decides.
 */
function keepsOut(s: MatchState, m: MatchPlayer): boolean {
  const w = s.offside;
  return !!w && w.team === m.team && w.players.includes(m.i) && s.ball.receiver !== m.i && offsideAware(s, m);
}

/** Orderings of up to three supporters, for matching them to the angles they offer. */
const PERMS: number[][][] = [[[]], [[0]], [[0, 1], [1, 0]], [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]];

/**
 * The angles (radians from straight at their goal) at which supporters offer
 * the carrier at `c` a short pass: the two forward diagonals and a ball back
 * inside, which with the carrier make the triangles a passing side plays in.
 * Near a touchline the outside angle is off the pitch, so the angles swing
 * inside: down the line, inside, and back inside. In the final third they
 * open out for lay-offs and cut-backs.
 */
function supportSlots(s: MatchState, team: 0 | 1, c: Vec, n: number): number[] {
  const dir = attackDir(s, team);
  // The rotation sign that turns "straight ahead" toward the middle of the pitch.
  const inSign = (MID_Y - c.y) * dir >= 0 ? 1 : -1;
  if (n <= 0) return [];
  if (Math.min(c.y, PITCH_H - c.y) < 11) return [[1 * inSign], [0.3 * inSign, 1.3 * inSign], [0.25 * inSign, 1.15 * inSign, 2.35 * inSign]][Math.min(n, 3) - 1];
  const a = teamX(s, team, c.x) > 0.78 ? 1.15 : 0.8;
  return [[0.9 * inSign], [-a, a], [-a, a, (Math.PI - 0.75) * inSign]][Math.min(n, 3) - 1];
}

function buildPlan(s: MatchState, team: 0 | 1): AiTeamPlan {
  const skill = skillOf(s, team);
  const k = tacticOf(s, team);
  const lag = reactionLag(skill);
  const b = s.ball;
  const owner = b.owner >= 0 ? s.players[b.owner] : null;
  const human = s.humans[team] ? s.controlled[team] : -1;
  const icpt: (AiInterception | null)[] = s.players.map(() => null);
  const mark: number[] = s.players.map(() => -1);
  const mates = s.players.filter((m) => m.team === team && m.role !== 'GK' && m.stun === 0 && !m.sentOff);
  let attacking: boolean;
  let chaser = -1;
  let bestUs = Infinity;
  let bestThem = Infinity;
  let focus: Vec;
  let pressured = false;

  if (owner) {
    focus = clampToPitch(sub(owner.pos, scale(owner.vel, lag)), 0.5);
    attacking = owner.team === team;
    if (!attacking) {
      const goal = ownGoal(s, team);
      const press = add(focus, scale(norm(sub(goal, focus)), 0.8));
      let best: MatchPlayer | null = null;
      for (const m of mates) if (!best || dist(m.pos, press) < dist(best.pos, press)) best = m;
      chaser = best && best.i !== human ? best.i : -1;
      pressured = !!best && dist(best.pos, owner.pos) < 5;
    }
  } else {
    const seen = clampToPitch(sub(b.pos, scale(b.vel, lag)), 0.3);
    const traj = trajectory(seen, b.vel, b.z, b.vz);
    let quickest: MatchPlayer | null = null;
    for (const m of s.players) {
      if (m.sentOff) continue;
      const ic = interceptOn(s, m, traj);
      icpt[m.i] = ic;
      if (m.team === team) {
        // A restart taker may not play it again until someone else has (Laws 8, 13-17): he leaves it.
        if (m.role !== 'GK' && m.stun === 0 && ic.t < bestUs && !keepsOut(s, m) && !barredSecondTouch(s, m)) {
          bestUs = ic.t;
          quickest = m;
        }
      } else if (ic.t < bestThem && !keepsOut(s, m)) bestThem = ic.t;
    }
    const receiver = b.receiver >= 0 ? s.players[b.receiver] : null;
    const lastOurs = b.lastTouch >= 0 && s.players[b.lastTouch].team === team;
    if (receiver && receiver.team === team && receiver.role !== 'GK' && receiver.stun === 0 && !keepsOut(s, receiver)) {
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

  // Counter-press: the moment the ball is lost, a pressing side hunts it.
  const prev = s.aiPlans?.[team];
  const lostAt = prev && prev.attacking && !attacking ? s.tick : prev?.lostAt ?? -1e6;
  const counterOn = !attacking && k.counter > 0 && s.tick - lostAt < k.counter;

  // The back line. Defending, it sits about 20 m behind the ball (Balanced),
  // a little deeper when nobody is pressing the carrier (so there is less
  // space in behind), and steps up as the ball goes back: that is the
  // offside trap. The mentality sets the gap and how high or deep it may go.
  const bx = teamX(s, team, focus.x);
  let line: number;
  if (attacking) line = clamp(bx - k.attGap, k.attMin, k.attMax);
  else {
    line = bx - (owner && !pressured && !counterOn ? k.lineGap : k.lineGap - 0.05) - (1 - skill) * 0.03;
    // Near our box the line holds at its edge rather than dropping onto the keeper.
    line = Math.max(line, Math.min(k.boxHold, bx - 0.04));
    line = clamp(Math.min(line, bx - 0.03), Math.min(k.lineMin, Math.max(0.05, bx - 0.03)), k.lineMax);
  }
  const oppLine = Math.max(secondLastOpponentX(s, team), teamX(s, team, b.pos.x), 0.5);

  // Pressing: whether the chaser goes in, and who presses with him.
  let engage = true;
  const pressers: number[] = [];
  const pressLane: number[] = [];
  if (owner && !attacking) {
    const ch = chaser >= 0 ? s.players[chaser] : null;
    engage = counterOn || bx <= k.pressUpTo || (!!ch && dist(ch.pos, owner.pos) < k.pressNear);
    const extra = Math.min(3, (bx > k.extraFrom ? k.extra : 0) + (counterOn ? k.counterN : 0));
    if (extra > 0) {
      const near = nearestK(mates, extra, (m) => (m.i === chaser || m.i === human ? null : dist2(m.pos, owner.pos)), 24 * 24);
      // The carrier's nearest options, whose passing lanes the pressers cut.
      const lanes = nearestK(s.players, 3, (o) => (o.team === team || o.sentOff || o.i === owner.i || o.role === 'GK' ? null : dist2(o.pos, owner.pos)));
      const taken: number[] = [];
      near.forEach((m, j) => {
        let lane = -1;
        // The last of three pressers doubles up on the carrier.
        if (!(extra === 3 && j === 2)) {
          let bestD = Infinity;
          for (const o of lanes) {
            if (taken.includes(o.i)) continue;
            const d = dist2(m.pos, { x: (owner.pos.x + o.pos.x) / 2, y: (owner.pos.y + o.pos.y) / 2 });
            if (d < bestD) {
              bestD = d;
              lane = o.i;
            }
          }
          if (lane >= 0) taken.push(lane);
        }
        pressers.push(m.i);
        pressLane.push(lane);
      });
    }
    // A block near its own box steps into the shooting lane: shots from the
    // edge of the area are what a deep side invites, so it puts bodies in front of them.
    if (k.screen > 0 && dist(owner.pos, ownGoal(s, team)) < k.screenR) {
      const goal = ownGoal(s, team);
      const dOwner = dist(owner.pos, goal);
      const near = nearestK(mates, k.screen, (m) =>
        m.i === chaser || m.i === human || m.role === 'GK' || pressers.includes(m.i) || dist(m.pos, goal) >= dOwner + 3 || dist2(m.pos, owner.pos) >= 18 * 18
          ? null
          : distToSegment(m.pos, owner.pos, goal),
      );
      near.forEach((m, j) => {
        pressers.push(m.i);
        pressLane.push(-2 - j);
      });
    }
  }

  // Support: the nearest teammates offer the carrier (or the man a pass is
  // going to) short passes at different angles, so there is always a triangle.
  const support: number[] = [];
  const supportAng: number[] = [];
  if (attacking) {
    const center = owner && owner.team === team ? owner : b.receiver >= 0 && s.players[b.receiver].team === team ? s.players[b.receiver] : null;
    if (center) {
      const cpos = owner ? owner.pos : focus;
      const cx = teamX(s, team, cpos.x);
      // The k.supporters nearest within 30 m, kept in order as they are found (this runs on every plan).
      const near: MatchPlayer[] = [];
      const nearD: number[] = [];
      for (const m of mates) {
        if (m.i === center.i || m.i === human || (m.sub === 'CB' && cx > line + 0.3)) continue;
        const dx = m.pos.x - cpos.x;
        const dy = m.pos.y - cpos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 900 || (near.length === k.supporters && d2 >= nearD[near.length - 1]) || keepsOut(s, m)) continue;
        let at = near.length;
        while (at > 0 && nearD[at - 1] > d2) at--;
        near.splice(at, 0, m);
        nearD.splice(at, 0, d2);
        if (near.length > k.supporters) {
          near.pop();
          nearD.pop();
        }
      }
      const angs = supportSlots(s, team, cpos, near.length);
      const fwd = { x: attackDir(s, team), y: 0 };
      const spots = angs.map((a) => add(cpos, scale(rotate(fwd, a), k.supportR)));
      let bestPerm = PERMS[near.length][0];
      let bestCost = Infinity;
      for (const perm of PERMS[near.length]) {
        let cost = 0;
        for (let j = 0; j < near.length; j++) cost += dist(near[j].pos, spots[perm[j]]);
        if (cost < bestCost) {
          bestCost = cost;
          bestPerm = perm;
        }
      }
      near.forEach((m, j) => {
        support.push(m.i);
        supportAng.push(angs[bestPerm[j]]);
      });
    }
  }

  let cover = -1;
  if (!attacking) {
    // Defending: mark the most dangerous attackers first, goal-side, each with
    // the defender whose zone is nearest. The carrier belongs to the chaser.
    const goal = ownGoal(s, team);
    const attackers = s.players
      .filter((o) => o.team !== team && o.role !== 'GK' && !o.sentOff && o.i !== b.owner && teamX(s, team, o.pos.x) < 0.42 + 0.2 * skill)
      .sort((x, y) => dist(x.pos, goal) - dist(y.pos, goal));
    const free = mates.filter((m) => m.i !== chaser && m.i !== human && !pressers.includes(m.i));
    const zone = free.map((d) => shapeTarget(s, d, false, focus, line, oppLine));
    // A low block marks zonally (only who comes into its zone); a pressing side follows its man further.
    const radius = (13 + 7 * skill) * k.markR;
    for (const a of attackers) {
      let best: MatchPlayer | null = null;
      let bestCost = radius;
      for (let j = 0; j < free.length; j++) {
        const d = free[j];
        if (mark[d.i] >= 0) continue;
        const cost = dist(zone[j], a.pos) * 0.55 + dist(d.pos, a.pos) * 0.45;
        if (cost < bestCost) {
          bestCost = cost;
          best = d;
        }
      }
      if (best) mark[best.i] = a.i;
    }
    // An unassigned midfielder screens in front of the back line.
    let deepest = Infinity;
    for (const d of free) {
      if (mark[d.i] >= 0 || d.role === 'DEF') continue;
      const x = teamX(s, team, d.pos.x);
      if (x < deepest) {
        deepest = x;
        cover = d.i;
      }
    }
  }
  const possSince = attacking && prev && prev.attacking ? prev.possSince : s.tick;
  return { tick: s.tick, attacking, chaser, focus, icpt, bestUs, bestThem, mark, cover, line, oppLine, possSince, engage, pressers, pressLane, lostAt, support, supportAng };
}

/**
 * Where a player belongs in the team's shape, given the ball (`focus`), the
 * height of our back line and the opponents' (for staying onside). Each
 * sub-role has its place relative to the line; the formation slot shifts it
 * higher or deeper, and the mentality sets how wide and how stretched the
 * shape is and how far the full-backs and wing-backs go.
 */
function shapeTarget(s: MatchState, p: MatchPlayer, attacking: boolean, focus: Vec, line: number, oppLine: number): Vec {
  const slot = slotOf(s, p);
  const k = tacticOf(s, p.team);
  const bx = teamX(s, p.team, focus.x);
  const by = focus.y / PITCH_H;
  const side = slot.y < 0.5 ? -1 : 1;
  const ballSide = (by < 0.5 ? -1 : 1) === side;
  const L = line;
  // Across the pitch the block shifts toward the ball; narrower out of possession.
  const width = attacking ? k.attWidth : k.defWidth;
  const squeeze = attacking ? 0.16 : k.squeeze;
  const depth = attacking ? k.attDepth : k.defDepth;
  // This formation's slot against where the sub-role usually stands.
  const adj = (slot.x - CANON_X[p.sub]) * (attacking ? 1.1 : 0.9);
  // The back line narrows (or widens) with the block: Balanced's 0.8 is the width it was tuned at.
  const narrow = k.defWidth / 0.8;
  let ny = (0.5 + (slot.y - 0.5) * width) * (1 - squeeze) + by * squeeze;
  let nx: number;
  switch (p.sub) {
    case 'GK':
      return fromTeam(s, p.team, 0.03, 0.5);
    case 'CB':
      nx = L;
      ny = 0.5 + (slot.y - 0.5) * (attacking ? 1.5 : 0.85 * narrow) + (by - 0.5) * 0.25;
      break;
    case 'FB':
      if (attacking && ballSide && bx > k.fbUp) {
        // Overlap: up the touchline beyond the wide man.
        nx = clamp(bx + 0.05, L + 0.05, 0.84);
        ny = side < 0 ? 0.05 : 0.95;
      } else if (attacking && !ballSide) {
        // The far full-back tucks in as rest defence, or pushes on in an attacking side.
        nx = L + (k.farFbUp ? 0.12 : 0.02);
        ny = 0.5 + side * (k.farFbUp ? 0.36 : 0.27);
      } else {
        nx = L + (attacking ? 0.04 : 0);
        ny = 0.5 + (slot.y - 0.5) * (attacking ? 1.05 : 0.82 * narrow) + (by - 0.5) * 0.3;
      }
      break;
    case 'WB':
      // The width of a back three: high and wide with the ball, back into a five without it.
      if (attacking && (k.wbUp === 2 || (k.wbUp === 1 && ballSide))) {
        nx = clamp(Math.max(bx - 0.04, L + 0.22 + adj), L + 0.1, 0.84);
        ny = side < 0 ? 0.04 : 0.96;
      } else if (attacking) {
        nx = L + 0.05;
        ny = 0.5 + side * 0.36;
      } else {
        // On the ball side, or with the ball near our goal, he drops into the back five.
        nx = ballSide || bx < 0.4 ? L + 0.01 : L + Math.max(0, adj) * 0.6;
        ny = 0.5 + (slot.y - 0.5) * 0.88 * narrow + (by - 0.5) * 0.28;
      }
      break;
    case 'DM':
      nx = L + (attacking ? 0.12 : 0.1) * depth + adj;
      ny = 0.5 + (by - 0.5) * 0.35 + (slot.y - 0.5) * 0.5;
      break;
    case 'CM':
      nx = L + (attacking ? 0.25 : 0.19) * depth + adj;
      break;
    case 'AM':
      // Between the lines, drifting to the ball side.
      nx = L + (attacking ? 0.36 : 0.28) * depth + adj;
      ny = 0.5 + (by - 0.5) * (attacking ? 0.3 : 0.4) + (slot.y - 0.5) * 0.6;
      break;
    case 'WM':
      nx = L + (attacking ? 0.32 : 0.21) * depth + adj;
      if (attacking) ny = side < 0 ? (ballSide ? 0.06 : 0.16) : ballSide ? 0.94 : 0.84;
      break;
    case 'W':
      nx = L + (attacking ? 0.42 : 0.36) * depth + adj;
      if (attacking) ny = side < 0 ? 0.07 : 0.93;
      break;
    case 'ST':
    default:
      nx = L + (attacking ? 0.46 : 0.4) * depth + adj + (slot.y > 0.5 ? 0.02 : 0);
      if (!attacking) ny = 0.5 + (slot.y - 0.5) * 0.9 + (by - 0.5) * 0.35;
      break;
  }
  if (attacking) {
    // Stay onside until the ball is played.
    const margin = (-0.6 + 1.8 * skillOf(s, p.team)) * M;
    nx = Math.min(nx, Math.max(0.5, oppLine - margin));
  }
  nx = clamp(nx + p.jitter.x * 0.4, 0.04, 0.95);
  ny = clamp(ny + p.jitter.y * 0.5, 0.04, 0.96);
  return fromTeam(s, p.team, nx, ny);
}

// ---------------------------------------------------------------------------
// Passing

export interface PassOption {
  receiver: MatchPlayer;
  target: Vec;
  score: number;
  /** True for a pass into space ahead of a runner rather than to feet. */
  through: boolean;
  /** A lofted ball (cross, long switch). */
  lofted?: boolean;
}

/** Lead a pass so it arrives where the receiver will be. */
export function leadTarget(from: Vec, m: MatchPlayer, passing: number): Vec {
  const d = dist(from, m.pos);
  const speed = passSpeed(d, passing);
  const t = d / (speed * 0.75);
  return clampToPitch(add(m.pos, scale(m.vel, Math.min(t, 1.2))), 1);
}

/** Pace for a ground pass over d metres: it arrives at about 7 m/s, easy to take in stride. */
export function passSpeed(d: number, passing: number): number {
  return clamp(8.5 + d * 0.36, 9.5, 22) * (0.9 + 0.2 * passing);
}

/** 0..1: how long this side has had the ball. Patience runs out after a few seconds of keeping it (sooner for an attacking side). */
function urgency(s: MatchState, team: 0 | 1): number {
  const plan = s.aiPlans?.[team];
  return plan && plan.attacking ? clamp(((s.tick - plan.possSince) * tacticOf(s, team).urgency - 90) / 300, 0, 1) : 0;
}

/**
 * Score a pass from the ball to `target` for receiver m. Higher is better;
 * about 0 is a safe sideways ball, below -1 is likely to be cut out.
 */
function evalPass(s: MatchState, p: MatchPlayer, m: MatchPlayer, target: Vec, through: boolean): number {
  const team = p.team;
  const from = s.ball.pos;
  const d = dist(from, target);
  if (d < 3.5 || d > 40) return -Infinity;
  const spd = passSpeed(d, p.attrs.passing) * (through ? 1.05 : 1);
  const vEff = spd * 0.85;
  const tBallEnd = d / vEff;
  const toT = sub(target, m.pos);
  const dT = len(toT);
  // A runner already moving toward the spot gets there sooner than a standing start.
  const onTheRun = dT > 0.5 ? clamp(dot(m.vel, scale(toT, 1 / dT)) / runSpeed(m), 0, 1) : 0;
  const tRecv = Math.max(0, dT - 0.9) / runSpeed(m) + 0.1 - 0.3 * onTheRun;
  const tTarget = teamX(s, team, target.x);
  const ab = sub(target, from);
  const d2 = d * d;
  let laneM = Infinity;
  let arriveM = Infinity;
  for (const o of s.players) {
    if (o.team === team || o.stun > 20 || o.sentOff) continue;
    const reach = o.role === 'GK' && inOwnBox(s, o.team, o.pos) ? 1.5 : 0.95;
    const oSp = runSpeed(o) * 0.95;
    const u = clamp(dot(sub(o.pos, from), ab) / d2, 0, 1);
    const proj = add(from, scale(ab, u));
    const perp = dist(o.pos, proj);
    const tBall = (u * d) / vEff;
    const tO = Math.max(0, perp - reach) / oSp + 0.18;
    if (u > 0.04) laneM = Math.min(laneM, tO - tBall);
    // A defender has to turn and chase a ball played in behind him.
    const turn = through && tTarget > teamX(s, team, o.pos.x) && o.role !== 'GK' ? 0.3 : 0;
    const tOA = Math.max(0, dist(o.pos, target) - reach) / oSp + 0.18 + turn;
    arriveM = Math.min(arriveM, tOA - Math.max(tRecv, tBallEnd));
  }
  const tx = tTarget;
  const gain = (tx - teamX(s, team, from.x)) * PITCH_W;
  const dGoal = dist(target, oppGoal(s, team));
  const urge = urgency(s, team);
  // Risk: an attacking side weighs how far forward a pass goes more, and how safe it is less.
  const risk = tacticOf(s, team).risk;
  let score = (gain * (0.14 + 0.06 * urge) + (dGoal < 26 ? (26 - dGoal) * (0.14 + 0.06 * urge) : 0)) * risk + tx * 1.3;
  score += (clamp(laneM, -0.6, 0.4) * 3 + clamp(arriveM, -0.6, 0.5) * 2) * (1 - 0.5 * urge) * (2 - risk) - d * 0.018;
  // Into the box is what it's all about.
  if (tx > 0.82 && Math.abs(target.y - MID_Y) < BOX_W / 2) score += 0.8 + 1.2 * urge;
  if (m.role === 'GK') score -= laneM > 0.6 && arriveM > 0.5 ? 1.2 : 4;
  // Never stroke it across the face of your own goal unless it's clearly safe.
  const own = ownGoal(s, team);
  if (distToSegment(own, from, target) < 14 && (laneM < 0.5 || arriveM < 0.3)) score -= 3.5;
  if (tx < 0.2 && Math.abs(target.y - MID_Y) < 14) score -= 1;
  // Off the pitch is a throw to them.
  if (target.y < 1 || target.y > PITCH_H - 1 || target.x < 1 || target.x > PITCH_W - 1) score -= 2;
  // Only when the runner clearly wins the race; a through ball that is merely possible is a giveaway.
  if (through && arriveM < 0.1 * (2 - risk)) score -= 2;
  // Law 11: a pass to a player in an offside position is a free kick to them.
  if (inOffsidePosition(s, m, from.x) && offsideAware(s, p)) score -= 8;
  // Switch of play: a long lateral ball out of a crowded side.
  if (Math.abs(target.y - from.y) > 20) {
    let crowd = 0;
    for (const o of s.players) if (o.team !== team && !o.sentOff && dist(o.pos, from) < 12) crowd++;
    if (crowd >= 3) score += 0.6;
  }
  return score;
}

/**
 * A CPU through ball: into the space a few metres ahead of the runner, so it
 * arrives in stride. Shorter than kicks.throughTarget, which leads generously
 * for a human who can adjust the run.
 */
function cpuThroughTarget(s: MatchState, from: Vec, m: MatchPlayer, passing: number): Vec {
  const d = dist(from, m.pos);
  const tBall = d / (passSpeed(d, passing) * 1.05 * 0.8);
  const vr = len(m.vel);
  const run = vr > 1.2 ? scale(m.vel, 1 / vr) : norm(add({ x: attackDir(s, m.team), y: 0 }, scale(norm(sub(oppGoal(s, m.team), m.pos)), 0.5)));
  const lead = clamp(Math.max(vr, 3) * tBall + 1.5, 3, 9);
  return clampToPitch(add(m.pos, scale(run, lead)), 1.5);
}

/**
 * A ball over the top into the space behind a high line, for a forward on the
 * shoulder of the last defender: what a pressing side's high line risks.
 * Scored on the race to where it comes down (defenders still facing upfield
 * have to turn first); null when the line isn't high or the race isn't on.
 */
function inBehindOption(s: MatchState, p: MatchPlayer, m: MatchPlayer, oppLine: number): PassOption | null {
  const team = p.team;
  if (oppLine > 0.74 || !(m.sub === 'ST' || m.sub === 'W' || m.sub === 'AM' || m.sub === 'WM')) return null;
  const px = teamX(s, team, s.ball.pos.x);
  const mx = teamX(s, team, m.pos.x);
  if (oppLine - px < 0.12 || mx < oppLine - 0.07 || inOffsidePosition(s, m, s.ball.pos.x)) return null;
  const tx = Math.min(0.9, oppLine + 0.11);
  const target = clampToPitch(fromTeam(s, team, tx, (m.pos.y + (MID_Y - m.pos.y) * 0.3) / PITCH_H), 4);
  const d = dist(s.ball.pos, target);
  if (d < 18 || d > 48) return null;
  // It comes down, and has to be brought under control.
  const tBall = chipPlan(s.ball.pos, target, chipPowerFor(d)).flight + 0.25;
  const tRun = Math.max(0, dist(m.pos, target) - 1) / (runSpeed(m) * SPRINT_MULT) + 0.2;
  let tDef = Infinity;
  for (const o of s.players) {
    if (o.team === team || o.sentOff || o.stun > 20) continue;
    const keeper = o.role === 'GK' && inOwnBox(s, o.team, target);
    const turn = !keeper && teamX(s, team, o.pos.x) < tx ? 0.35 : 0;
    tDef = Math.min(tDef, Math.max(0, dist(o.pos, target) - (keeper ? 1.6 : 0.9)) / (runSpeed(o) * SPRINT_MULT * 0.97) + 0.2 + turn);
  }
  const margin = tDef - Math.max(tRun, tBall);
  if (margin < 0.15) return null;
  return { receiver: m, target, score: 1.5 + clamp(margin, 0, 1) * 2.5 + (tx - px) * PITCH_W * 0.05, through: true, lofted: true };
}

export function bestPassOption(s: MatchState, p: MatchPlayer, noise = 0): PassOption | null {
  let best: PassOption | null = null;
  const dir = attackDir(s, p.team);
  const oppLine = secondLastOpponentX(s, p.team);
  const consider = (m: MatchPlayer, target: Vec, through: boolean) => {
    const sc = evalPass(s, p, m, target, through);
    if (sc === -Infinity) return;
    const score = sc + (noise > 0 ? gauss(s.rng) * noise : 0);
    if (!best || score > best.score) best = { receiver: m, target, score, through };
  };
  const px = teamX(s, p.team, p.pos.x);
  for (const m of s.players) {
    if (m.team !== p.team || m.i === p.i || m.stun > 0 || m.sentOff) continue;
    consider(m, leadTarget(p.pos, m, p.attrs.passing), false);
    if (m.role === 'GK') continue;
    // Through ball into space ahead of a runner, or ahead of a forward who is level or beyond.
    const fwdSpeed = m.vel.x * dir;
    const mx = teamX(s, p.team, m.pos.x);
    const behind = inBehindOption(s, p, m, oppLine);
    if (behind) {
      const score = behind.score + (noise > 0 ? gauss(s.rng) * noise : 0);
      if (!best || score > best.score) best = { ...behind, score };
    }
    if (px > 0.8 || !(fwdSpeed > 1.5 || mx > px + 0.06)) continue;
    consider(m, cpuThroughTarget(s, s.ball.pos, m, p.attrs.passing), true);
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
    if (m.team !== p.team || m.i === p.i || m.sentOff) continue;
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

/** Chip power that lands a ball at distance d (inverse of kicks.chipRange). */
const chipPowerFor = (d: number): number => clamp((d - 6) / 44 + 0.03, 0.05, 1);

/**
 * Direct play: a long ball over the top to the forward with the most room
 * around him, at least 20 m further up. Null when nobody is up there.
 */
function bestLongBall(s: MatchState, p: MatchPlayer, noise: number): PassOption | null {
  const team = p.team;
  const px = teamX(s, team, s.ball.pos.x);
  let best: PassOption | null = null;
  for (const m of s.players) {
    if (m.team !== team || m.i === p.i || m.sentOff || m.role === 'GK' || m.stun > 0) continue;
    if (!(m.sub === 'ST' || m.sub === 'W' || m.sub === 'AM' || m.sub === 'WM')) continue;
    const mx = teamX(s, team, m.pos.x);
    const d = dist(s.ball.pos, m.pos);
    if (mx < px + 0.19 || d > 48) continue;
    if (inOffsidePosition(s, m, s.ball.pos.x) && offsideAware(s, p)) continue;
    // Drop it a few metres in front of him, toward their goal.
    const target = clampToPitch(add(m.pos, scale(norm(sub(oppGoal(s, team), m.pos)), 2.5)), 3);
    let room = 8;
    for (const o of s.players) if (o.team !== team && !o.sentOff) room = Math.min(room, dist(o.pos, target));
    const score = room * 0.5 + mx * 2 + gauss(s.rng) * noise;
    if (!best || score > best.score) best = { receiver: m, target, score, through: false, lofted: true };
  }
  return best && best.score > 2.6 ? best : null;
}

/**
 * A cross from a wide area: lofted to the attacker in the box with the most
 * room, or to the penalty spot area. Null when nobody is there.
 */
function bestCross(s: MatchState, p: MatchPlayer, noise: number): PassOption | null {
  const team = p.team;
  const goal = oppGoal(s, team);
  let best: PassOption | null = null;
  for (const m of s.players) {
    if (m.team !== team || m.i === p.i || m.sentOff || m.role === 'GK') continue;
    const mx = teamX(s, team, m.pos.x);
    if (mx < 0.8 || Math.abs(m.pos.y - MID_Y) > BOX_W / 2 - 2) continue;
    if (inOffsidePosition(s, m, s.ball.pos.x) && offsideAware(s, p)) continue;
    let room = 6;
    for (const o of s.players) if (o.team !== team && !o.sentOff && o.role !== 'GK') room = Math.min(room, dist(o.pos, m.pos));
    const target = clampToPitch(add(m.pos, scale(norm(sub(goal, m.pos)), 0.8)), 2);
    const dG = dist(target, goal);
    const score = room * 0.45 - dG * 0.06 + 0.6 + gauss(s.rng) * noise;
    if (!best || score > best.score) best = { receiver: m, target, score, through: false, lofted: true };
  }
  return best;
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
  const goal = oppGoal(s, team);
  const gk = goalkeeper(s, team === 0 ? 1 : 0);
  const dGoal = dist(p.pos, goal);
  const dx = Math.abs(goal.x - p.pos.x);
  // Angle the goal mouth subtends.
  const a1 = Math.atan2(GOAL_TOP - p.pos.y, dx);
  const a2 = Math.atan2(GOAL_BOTTOM - p.pos.y, dx);
  const angle = Math.abs(a2 - a1);
  // Aim at the post the keeper is further from.
  const inset = 0.6;
  const top = { x: goal.x, y: GOAL_TOP + inset };
  const bottom = { x: goal.x, y: GOAL_BOTTOM - inset };
  const kTop = distToSegment(gk.pos, p.pos, top);
  const kBottom = distToSegment(gk.pos, p.pos, bottom);
  const target = kTop > kBottom ? top : bottom;
  const keeperGap = Math.max(kTop, kBottom);
  let blockers = 0;
  for (const o of s.players) {
    if (o.team === team || o.role === 'GK' || o.sentOff) continue;
    if (distToSegment(o.pos, p.pos, target) < 0.9 && dist(o.pos, p.pos) < dGoal) blockers++;
  }
  // Conversion by distance (about 45% inside 6 m, 18% at 6-12 m, 6% at
  // 12-18 m, 2% beyond), scaled by how much of the goal is visible, where the
  // keeper is, the shooter and anyone in the way.
  const central = clamp(angle / (2 * Math.atan(GOAL_HALF / Math.max(dGoal, 0.5))), 0.15, 1);
  const keeperFactor = clamp(0.55 + keeperGap * 0.2, 0.55, 1.3);
  const xg = clamp(0.8 * Math.exp(-dGoal / 6.5) * central * (0.55 + 0.7 * p.attrs.shooting) * keeperFactor * Math.pow(0.5, blockers), 0, 0.95);
  const power = clamp(0.78 + dGoal * 0.008, 0.6, 0.97);
  return { xg, target, power, chip: false };
}

/** A chip over a keeper who has come off his line. Null when it isn't on. */
function evalChip(s: MatchState, p: MatchPlayer): ShotOption | null {
  const team = p.team;
  const goal = oppGoal(s, team);
  const gk = goalkeeper(s, team === 0 ? 1 : 0);
  const dGoal = dist(p.pos, goal);
  if (dGoal < 8 || dGoal > 24) return null;
  const off = Math.abs(gk.pos.x - goal.x);
  if (off < 4) return null;
  // The keeper must be between shooter and goal, and the shot angle decent.
  if (distToSegment(gk.pos, p.pos, goal) > 2.5 || Math.abs(p.pos.y - MID_Y) > dGoal * 0.7) return null;
  const dir = attackDir(s, team);
  const target = { x: goal.x + dir * 0.8, y: clamp(p.pos.y, GOAL_TOP + 1, GOAL_BOTTOM - 1) * 0.3 + MID_Y * 0.7 };
  const d = dist(p.pos, target);
  const power = chipPowerFor(d);
  const plan = chipPlan(p.pos, target, power);
  // Nobody but the keeper should be under its flight near the landing.
  for (const o of s.players) {
    if (o.team === team || o.role === 'GK' || o.sentOff) continue;
    if (dist(o.pos, plan.landing) < 3) return null;
  }
  const xg = clamp((0.16 + 0.04 * (off - 4)) * (0.6 + 0.6 * p.attrs.shooting), 0, 0.45);
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
  if (opt.lofted) return { move: p.facing, throttle: 0.5, action: { kind: 'chip', target, power: chipPowerFor(dist(s.ball.pos, target)) } };
  return { move: p.facing, throttle: 0.6, action: { kind: 'pass', target, receiver: opt.receiver.i, through: opt.through } };
}

function shootIntent(s: MatchState, p: MatchPlayer, shot: ShotOption, skill: number): Intent {
  const target = { x: shot.target.x, y: shot.target.y + gauss(s.rng) * (0.25 + 0.8 * (1 - skill)) };
  p.ai!.mode = 'none';
  const move = norm(sub(oppGoal(s, p.team), p.pos));
  if (shot.chip) return { move, throttle: 0.8, action: { kind: 'chip', target, power: shot.power } };
  return { move, throttle: 1, action: { kind: 'shoot', target, power: shot.power } };
}

/** A long, lofted clearance toward the emptier flank, well upfield. */
function clearance(s: MatchState, p: MatchPlayer, far: number): Action {
  const dir = attackDir(s, p.team);
  let topCrowd = 0;
  for (const o of s.players) if (o.team !== p.team && !o.sentOff && o.pos.y < MID_Y) topCrowd++;
  const y = topCrowd <= 4 ? range(s.rng, 6, 18) : range(s.rng, PITCH_H - 18, PITCH_H - 6);
  const target = { x: clamp(ownGoal(s, p.team).x + dir * far, 8, PITCH_W - 8), y };
  return { kind: 'chip', target, power: chipPowerFor(dist(s.ball.pos, target)) };
}

function ownerIntent(s: MatchState, p: MatchPlayer): Intent {
  const mem = memOf(s, p);
  const skill = skillOf(s, p.team);
  const k = tacticOf(s, p.team);
  const goal = oppGoal(s, p.team);
  const dir = attackDir(s, p.team);
  const px = teamX(s, p.team, p.pos.x);

  let nearest: MatchPlayer | null = null;
  let pressure = Infinity;
  for (const o of s.players) {
    if (o.team === p.team || o.sentOff) continue;
    const d = dist(o.pos, p.pos);
    if (d < pressure) {
      pressure = d;
      nearest = o;
    }
  }

  // Sharper players notice a closing defender sooner.
  if (pressure < 2.2 && p.aiTimer > 2 + Math.round(6 * (1 - skill))) p.aiTimer = 2 + Math.round(6 * (1 - skill));
  // Don't run the ball out of play: decide now.
  const nearLine = p.pos.y < 2.2 || p.pos.y > PITCH_H - 2.2 || teamX(s, p.team, p.pos.x) > 0.975;
  if (nearLine && p.aiTimer > 3) p.aiTimer = 3;

  if (p.aiTimer <= 0) {
    p.aiTimer = Math.max(2, Math.round(decisionInterval(s, p) * k.tempo));
    const noise = 0.15 + 0.4 * (1 - skill) * (1 - skill);
    let shot = evalShot(s, p);
    const chipShot = skill > 0.3 && p.attrs.shooting > 0.5 ? evalChip(s, p) : null;
    if (chipShot && chipShot.xg > shot.xg && chance(s.rng, 0.4 + 0.4 * skill)) shot = chipShot;
    const urge = urgency(s, p.team);
    const shotScore = shot.xg * (1 + gauss(s.rng) * (0.15 + 0.5 * (1 - skill))) * (1 + 0.8 * urge);
    const opt = bestPassOption(s, p, noise);
    const passScore = opt ? opt.score : -Infinity;

    // From the edge of the box, a strike is often the best thing on (more or less often by mentality).
    const far = dist(p.pos, goal) > LONG_SHOT_FROM;
    const keen = far ? k.shootLong : 1;
    const longShot = px > 0.66 && shotScore * keen > SHOOT_XG * 0.35 && passScore < 2 && chance(s.rng, (0.15 + 0.3 * p.attrs.shooting + 0.25 * urge) * keen);
    if (shotScore * keen > SHOOT_XG || longShot || (shotScore > SHOOT_XG * 0.6 && pressure < 2 && passScore < 1.2)) return shootIntent(s, p, shot, skill);

    // Wide in the final third: cross it.
    const wide = Math.abs(p.pos.y - MID_Y) > BOX_W / 2 - 6;
    if (px > 0.62 && wide) {
      const cross = bestCross(s, p, noise);
      const byline = px > 0.84 || pressure < 3;
      if (cross && (byline || chance(s.rng, 0.45 + 0.25 * skill + 0.3 * urge))) return passIntent(s, p, cross, skill);
    }

    // How much open grass is ahead to carry into.
    let clear = 9;
    for (const o of s.players) {
      if (o.team === p.team || o.sentOff) continue;
      const to = sub(o.pos, p.pos);
      const d = len(to);
      if (d < 9 && to.x * dir > -0.5) clear = Math.min(clear, d);
    }
    // Carrying is worth most through midfield; near the box the line is set and the ball should move.
    const carryScore = clamp((clear - 2.5) / 4, 0, 1) * (3 + 2 * clamp((px - 0.45) * 4, 0, 1)) * (px > 0.7 ? 0.45 : 1) * k.carry;

    // A deep side doesn't build up through its own half: it goes long early.
    if (k.direct > 0 && px < 0.5 && passScore < 3 && chance(s.rng, k.direct)) {
      const long = bestLongBall(s, p, noise);
      if (long) return passIntent(s, p, long, skill);
    }

    if (opt) {
      const underPressure = pressure < 2.3 && passScore > -0.4;
      const better = passScore > carryScore + 1.5 - 0.4 * p.attrs.passing;
      const deep = px < 0.3 && pressure < 6 && passScore > -0.8;
      if (underPressure || better || deep || (nearLine && passScore > -1.5)) return passIntent(s, p, opt, skill);
    }

    // Take a man on: one defender in front, nobody else close, a good dribbler.
    if (nearest && pressure < 4.5 && px > 0.35 && p.attrs.dribbling > 0.55) {
      let others = 0;
      for (const o of s.players) if (o.team !== p.team && !o.sentOff && o.i !== nearest.i && dist(o.pos, p.pos) < 7) others++;
      const ahead = (nearest.pos.x - p.pos.x) * dir > -0.3;
      if (others === 0 && ahead && chance(s.rng, (p.attrs.dribbling - 0.45) * (0.6 + 0.8 * skill))) {
        const side = nearest.pos.y > MID_Y ? -1 : 1;
        mem.mode = 'takeon';
        mem.modeTicks = 26;
        mem.modeTarget = clampToPitch({ x: nearest.pos.x + dir * 4, y: nearest.pos.y + side * 2.4 }, 2);
      }
    }

    // Shield near the touchline when pressed and nothing is on.
    const tight = p.pos.y < 5 || p.pos.y > PITCH_H - 5;
    if (mem.mode === 'none' && nearest && pressure < 2.4 && tight && passScore < 0.6) {
      mem.mode = 'shield';
      mem.modeTicks = 18 + Math.round(12 * skill);
      p.aiTimer = Math.min(p.aiTimer, 5);
    }

    // Pinned in by our own corner flag: put it behind or into touch, and defend the set piece.
    if (px < 0.12 && Math.abs(p.pos.y - MID_Y) > GOAL_W && pressure < 2.5 && passScore < 0 && chance(s.rng, 0.5)) {
      const behind = chance(s.rng, 0.6);
      const out = behind ? { x: ownGoal(s, p.team).x - dir * 4, y: p.pos.y < MID_Y ? p.pos.y - 3 : p.pos.y + 3 } : { x: p.pos.x + dir * 6, y: p.pos.y < MID_Y ? -4 : PITCH_H + 4 };
      return { move: p.facing, throttle: 0.5, action: { kind: 'shoot', target: out, power: 0.5 } };
    }
    // In trouble deep in our half: clear it (a deep-lying side clears sooner, an attacking one plays out).
    if (px < 0.25 + Math.max(0, k.clear) * 0.1 && pressure < 2.2 + k.clear && passScore < -0.6 + k.clear) {
      return { move: p.facing, throttle: 0.6, action: clearance(s, p, range(s.rng, 40, 55)) };
    }
  }

  if (mem.mode === 'takeon' && mem.modeTarget && mem.modeTicks-- > 0) {
    if (dist(p.pos, mem.modeTarget) < 1) mem.mode = 'none';
    return { move: norm(sub(mem.modeTarget, p.pos)), throttle: 1, sprint: sprintOk(s, p, true) };
  }
  if (mem.mode === 'shield' && nearest && mem.modeTicks-- > 0) {
    // Body between ball and defender: drift away from them, back infield.
    const away = norm(sub(p.pos, nearest.pos));
    const inward = { x: -dir * 0.4, y: p.pos.y < MID_Y ? 0.5 : -0.5 };
    return { move: norm(add(away, inward)), throttle: 0.45 };
  }
  mem.mode = 'none';

  // Carry toward goal, steering around opponents ahead. A wide man goes down
  // the line toward the byline, to cross.
  const flank = (p.sub === 'WM' || p.sub === 'W' || p.sub === 'FB' || p.sub === 'WB') && Math.abs(p.pos.y - MID_Y) > BOX_W / 2 - 4 && px > 0.5 && px < 0.9;
  let desired = flank ? norm({ x: dir, y: (p.pos.y < MID_Y ? 1 : -1) * 0.12 }) : norm(sub(goal, p.pos));
  const look = 4 + 2 * skill;
  for (const o of s.players) {
    if (o.team === p.team || o.sentOff) continue;
    const to = sub(o.pos, p.pos);
    const d = len(to);
    if (d > look || dot(to, desired) <= 0) continue;
    const side = to.x * desired.y - to.y * desired.x > 0 ? 1 : -1;
    const perp = { x: -desired.y * side, y: desired.x * side };
    desired = add(desired, scale(perp, ((look - d) / look) * 1.3));
  }
  // Stay in play.
  if (p.pos.y < 3.5) desired.y += 0.9;
  if (p.pos.y > PITCH_H - 3.5) desired.y -= 0.9;
  if (teamX(s, p.team, p.pos.x) > 0.96) desired.x = -dir * 0.3;
  return { move: norm(desired), throttle: 1, sprint: sprintOk(s, p, pressure > 4 && px > 0.4 && px < 0.85) };
}

// ---------------------------------------------------------------------------
// Goalkeeper

/** A penalty has just been struck: the keeper commits to a side (seeded), the way keepers do. Called by match.ts. */
export function penaltyDive(s: MatchState, gk: MatchPlayer, shotY: number): number {
  const mem = memOf(s, gk);
  const own = ownGoal(s, gk.team);
  const actual = shotY < MID_Y - 1 ? -1 : shotY > MID_Y + 1 ? 1 : 0;
  // A good keeper reads it a little more often than a coin toss.
  let side: number;
  if (chance(s.rng, 0.12 + 0.2 * gk.attrs.goalkeeping)) side = actual;
  else {
    const r = next(s.rng);
    side = r < 0.44 ? -1 : r < 0.88 ? 1 : 0;
  }
  mem.mode = 'dive';
  mem.modeTicks = 40;
  mem.modeTarget = { x: own.x + attackDir(s, gk.team) * 0.4, y: MID_Y + side * (GOAL_W / 2 - 0.4) };
  mem.lastTick = s.tick;
  return side;
}

function gkIntent(s: MatchState, p: MatchPlayer): Intent {
  const ball = s.ball;
  const own = ownGoal(s, p.team);
  const dir = attackDir(s, p.team);
  const skill = skillOf(s, p.team);
  const mem = memOf(s, p);

  if (mem.mode === 'dive') {
    // Committed: the dive carries him only so far, so a well-placed kick beats him even when he guesses right.
    if (mem.modeTarget && mem.modeTicks-- > 0) return seek(p, mem.modeTarget, 0.2, 0.45 + 0.2 * p.attrs.goalkeeping);
    mem.mode = 'none';
  }

  if (ball.owner === p.i) {
    p.holdTicks++;
    const inBox = inOwnBox(s, p.team, p.pos);
    const hold = inBox ? Math.round(48 - 26 * skill) : 4;
    if (p.holdTicks > hold) {
      // Distribute: prefer the open full-back, then a midfielder.
      let best: PassOption | null = null;
      for (const m of s.players) {
        if (m.team !== p.team || m.i === p.i || m.stun > 0 || m.sentOff) continue;
        const target = leadTarget(p.pos, m, p.attrs.passing);
        let sc = evalPass(s, p, m, target, false);
        if (sc === -Infinity) continue;
        sc += (m.sub === 'FB' || m.sub === 'WB' ? 1.3 : m.role === 'DEF' ? 0.9 : m.role === 'MID' ? 0.4 : 0) + gauss(s.rng) * (1 - skill) * 0.8;
        if (!best || sc > best.score) best = { receiver: m, target, score: sc, through: false };
      }
      if (best && best.score > -0.2) return passIntent(s, p, best, skill);
      // Nothing on: kick it long.
      return { move: IDLE.move, throttle: 0, action: clearance(s, p, range(s.rng, 48, 60)) };
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
  let depth = threatened ? clamp(0.8 + dB * 0.06, 1.1, 3) : clamp(1.5 + dB * 0.06, 1.5, 9);
  // One-on-one: carrier through with nobody between him and goal: come out to narrow the angle.
  if (owner && owner.team !== p.team && dB < 18) {
    let covered = false;
    for (const m of s.players) {
      if (m.team !== p.team || m.role === 'GK' || m.sentOff) continue;
      if (distToSegment(m.pos, owner.pos, own) < 1.5) covered = true;
    }
    if (!covered) depth = clamp(dB * (0.25 + 0.15 * skill), depth, 6);
  }
  let target = add(own, scale(norm(dB > 0.1 ? toBall : { x: dir, y: 0 }), depth));
  // Weak keepers drift back toward the middle of the goal.
  const lazy = (1 - skill) * 0.35;
  target = add(scale(target, 1 - lazy), scale({ x: own.x + dir * 1.2, y: MID_Y }, lazy));
  const nx = clamp(teamX(s, p.team, target.x) * PITCH_W, 0.7, BOX_DEPTH - 2);
  const spot = { x: own.x + dir * nx, y: clamp(target.y, GOAL_TOP - 1.5, GOAL_BOTTOM + 1.5) };

  // Shot or loose ball heading at goal: shift from the angle spot toward its
  // path. Only partly: how far a keeper gets across is his reflexes.
  if (!owner && ball.vel.x * dir < -3) {
    const tLine = (own.x - ball.pos.x) / ball.vel.x;
    const yCross = ball.pos.y + ball.vel.y * tLine;
    if (tLine > 0 && tLine < 1.6 && yCross > GOAL_TOP - 1.5 && yCross < GOAL_BOTTOM + 1.5) {
      // Reaction time: a keeper is set for a moment after the strike before he moves.
      const kicker = ball.kickedBy >= 0 ? s.players[ball.kickedBy] : null;
      if (kicker && kicker.team !== p.team && 18 - kicker.kickCd < 13 - 7 * p.attrs.goalkeeping) return IDLE;
      const lineX = Math.abs(p.pos.x - own.x) < 0.6 ? own.x + dir * 0.6 : p.pos.x;
      const tx = (lineX - ball.pos.x) / ball.vel.x;
      const pathY = tx > 0 ? ball.pos.y + ball.vel.y * tx : yCross;
      // How far across he gets is his reflexes, and the time he has: a shot from distance,
      // in flight for most of a second, gives even a weak keeper time to get in line.
      const flight = (s.tick - (ball.redirectedAt ?? s.tick)) / TICK_HZ + tx;
      const quick = clamp(0.04 + 0.42 * p.attrs.goalkeeping + 0.1 * skill, 0, 1);
      const react = quick + (1 - quick) * clamp((flight - GK_TIME_FROM) / GK_TIME_SPAN, 0, 1);
      const y = spot.y + (clamp(pathY, GOAL_TOP - 0.8, GOAL_BOTTOM + 0.8) - spot.y) * react;
      return seek(p, { x: lineX, y }, 0.5, 0.75 + 0.2 * p.attrs.goalkeeping);
    }
  }

  // Sweep or claim: a loose ball (through ball, cross) I reach first, in or near my box. Not his own
  // goal kick or free kick, which someone else must touch first.
  if (!owner && !barredSecondTouch(s, p)) {
    const mine = plan.icpt[p.i];
    const receiver = ball.receiver >= 0 ? s.players[ball.receiver] : null;
    const toTeammate = receiver && receiver.team === p.team && receiver.i !== p.i;
    // A high ball he can only claim near goal; a ball on the floor anywhere in his area.
    const reachX = s.ball.z > 0.5 || s.ball.vz > 0.5 ? 6 + 2 * skill : BOX_DEPTH - 3 + 4 * skill;
    if (mine && !toTeammate && teamX(s, p.team, mine.pt.x) * PITCH_W < reachX && Math.abs(mine.pt.y - MID_Y) < BOX_W / 2 - 2) {
      const margin = 0.45 - 0.3 * skill;
      if (mine.t + margin < plan.bestThem && mine.t <= plan.bestUs + 0.2) return seek(p, mine.pt, 0.8);
    }
  }

  return seek(p, spot, 1.2);
}

// ---------------------------------------------------------------------------
// Off the ball, team in possession

/**
 * A supporter's spot: a short, open pass from the carrier at the angle the
 * plan gave him (a forward diagonal or a ball back inside). He looks around
 * that angle at a few distances and takes the spot with the clearest lane
 * (not hidden behind an opponent), the most room and the least company, and
 * moves again a few times a second as the lanes close: that is the movement
 * that keeps a passing side's triangles open.
 */
/** Is an opponent standing in the passing lane from `from` to `to`? */
function laneShut(s: MatchState, team: 0 | 1, from: Vec, to: Vec): boolean {
  for (const o of s.players) if (o.team !== team && !o.sentOff && distToSegment(o.pos, from, to) < 1.4) return true;
  return false;
}

/** A supporter tries his angle and a little either side of it, short and a bit longer. */
const SUPPORT_TURN = [-0.4, 0, 0.4];
const SUPPORT_REACH = [0.75, 1, 1.25];

function supportSpot(s: MatchState, p: MatchPlayer, plan: AiTeamPlan, carrier: MatchPlayer | null, j: number): Vec {
  const team = p.team;
  const k = tacticOf(s, team);
  const skill = skillOf(s, team);
  // Where the ball will be: the carrier a moment from now, or where the pass is going.
  const c = carrier ? clampToPitch(add(carrier.pos, scale(carrier.vel, 0.3)), 0.5) : plan.focus;
  const cx = teamX(s, team, c.x);
  const onsideX = Math.max(0.5, plan.oppLine - (-0.6 + 1.8 * skill) * M);
  const base = plan.supportAng![j];
  const noise = 0.1 + 0.6 * (1 - skill);
  let best = c;
  let bestScore = -Infinity;
  // Opponents a moment from now: a lane someone is stepping into is already shut.
  const opp: Vec[] = [];
  // Where teammates are, or are heading: spots too close to them are crowded. Only players near
  // enough to the carrier to touch a lane or crowd a spot this short count.
  const mates: Vec[] = [];
  const near = k.supportR * SUPPORT_REACH[SUPPORT_REACH.length - 1] + 9;
  const near2 = near * near;
  for (const o of s.players) {
    if (o.sentOff) continue;
    if (o.team !== team) {
      const x = o.pos.x + o.vel.x * 0.35;
      const y = o.pos.y + o.vel.y * 0.35;
      if ((x - c.x) ** 2 + (y - c.y) ** 2 < near2) opp.push({ x, y });
    } else if (o.i !== p.i && o.role !== 'GK' && o.i !== carrier?.i) {
      const spot = o.ai?.target && o.ai.attacking ? o.ai.target : o.pos;
      if ((spot.x - c.x) ** 2 + (spot.y - c.y) ** 2 < near2) mates.push(spot);
    }
  }
  // Plain numbers in this loop: it runs for every candidate spot (no vectors made but the winner).
  const fx = attackDir(s, team);
  const toTeamX = (x: number) => (fx > 0 ? x / PITCH_W : 1 - x / PITCH_W);
  const fromTeamX = (nx: number) => (fx > 0 ? nx * PITCH_W : (1 - nx) * PITCH_W);
  const sixYard = cx < 0.3;
  for (const da of SUPPORT_TURN) {
    const dx = fx * Math.cos(base + da);
    const dy = fx * Math.sin(base + da);
    for (const rf of SUPPORT_REACH) {
      const r = k.supportR * rf;
      let x = Math.min(PITCH_W - 2, Math.max(2, c.x + dx * r));
      const y = Math.min(PITCH_H - 2, Math.max(2, c.y + dy * r));
      if (toTeamX(x) > onsideX) x = fromTeamX(onsideX);
      // Never a square ball across our own six-yard box.
      if (sixYard && toTeamX(x) < 0.1) x = fromTeamX(0.1);
      const cand = { x, y };
      let lane = 5;
      let space2 = 64;
      for (const o of opp) {
        lane = Math.min(lane, distToSegment(o, c, cand));
        space2 = Math.min(space2, (o.x - x) ** 2 + (o.y - y) ** 2);
      }
      let score = Math.min(lane, 4) * 1.1 + Math.sqrt(space2) * 0.35 - (lane < 1.6 ? 3 : 0);
      for (const spot of mates) {
        const d2 = (spot.x - x) ** 2 + (spot.y - y) ** 2;
        if (d2 < 49) score -= (7 - Math.sqrt(d2)) * 0.45;
      }
      const dc = Math.sqrt((x - c.x) ** 2 + (y - c.y) ** 2);
      if (dc < 5) score -= (5 - dc) * 0.8;
      score += (toTeamX(x) - cx) * PITCH_W * 0.035 - Math.sqrt((p.pos.x - x) ** 2 + (p.pos.y - y) ** 2) * 0.05 + gauss(s.rng) * noise;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
  }
  return best;
}

function supportTarget(s: MatchState, p: MatchPlayer, plan: AiTeamPlan, carrier: MatchPlayer | null): Vec {
  const mem = memOf(s, p);
  const sj = plan.support ? plan.support.indexOf(p.i) : -1;
  // A supporter re-reads the lanes every few ticks; everyone else holds a target longer. One who
  // has just become a supporter drops the target he had and finds his angle at once, and one
  // whose lane has just been shut moves again straight away (checked every third tick: lanes
  // don't open and shut faster than a player can react).
  const newSupporter = sj >= 0 && !mem.supporting;
  mem.supporting = sj >= 0;
  if (sj >= 0 && carrier && mem.retarget > 2 && (s.tick + p.i) % 3 === 0 && laneShut(s, p.team, carrier.pos, p.pos)) mem.retarget = 0;
  if (mem.target && mem.attacking && !newSupporter && mem.retarget-- > 0) return mem.target;
  const skill = skillOf(s, p.team);
  const k = tacticOf(s, p.team);
  mem.attacking = true;
  if (sj >= 0) {
    mem.retarget = Math.round(10 + 8 * (1 - skill) + next(s.rng) * 4);
    mem.target = supportSpot(s, p, plan, carrier, sj);
    return mem.target;
  }
  mem.retarget = Math.round(14 + 22 * (1 - skill) + next(s.rng) * 10);

  const team = p.team;
  const dir = attackDir(s, team);
  const focus = plan.focus;
  const fx = teamX(s, team, focus.x);
  const anchor = shapeTarget(s, p, true, focus, plan.line, plan.oppLine);
  const fwd = { x: dir, y: 0 };
  const cands: Vec[] = [anchor, add(anchor, { x: dir * 5, y: 0 }), add(anchor, { x: 0, y: 6 }), add(anchor, { x: 0, y: -6 })];
  const sub_ = p.sub;
  const forward = sub_ === 'ST' || sub_ === 'W' || sub_ === 'WM' || sub_ === 'CM' || sub_ === 'AM';
  // Who commits forward is the mentality's call: a low block keeps everyone but the strikers back.
  const runner = runsIntoBox(k, sub_);
  // How far forward a runner may stand and still be onside.
  const onsideX = Math.max(0.5, plan.oppLine - (-0.6 + 1.8 * skill) * M);

  // A run in behind: from onside, spin past the last defender while the
  // carrier has his head up. Timed right it beats the trap; late, it's offside.
  if (carrier && runner && (sub_ === 'ST' || sub_ === 'W' || sub_ === 'AM') && fx > 0.4 && fx < 0.82 && teamX(s, team, p.pos.x) > onsideX - 0.06) {
    let free = Infinity;
    for (const o of s.players) if (o.team !== team && !o.sentOff) free = Math.min(free, dist(o.pos, carrier.pos));
    if (free > 3 && chance(s.rng, (0.45 + 0.3 * skill) * (sub_ === 'AM' ? 0.5 : 1))) {
      mem.retarget = Math.round(40 + 20 * next(s.rng));
      const y = clamp(p.pos.y + (MID_Y - p.pos.y) * 0.3 + range(s.rng, -6, 6), 6, PITCH_H - 6);
      mem.target = fromTeam(s, team, Math.min(0.95, plan.oppLine + 0.13), y / PITCH_H);
      return mem.target;
    }
  }

  if (sub_ === 'ST' || sub_ === 'W') {
    // On the shoulder of the last defender, ready to spin in behind.
    cands.push(fromTeam(s, team, onsideX, anchor.y / PITCH_H));
    cands.push(fromTeam(s, team, onsideX, clamp((focus.y + (anchor.y < focus.y ? -10 : 10)) / PITCH_H, 0.08, 0.92)));
  }
  // Ball wide in the final third: get into the box for the cross.
  if (fx > 0.7 && Math.abs(focus.y - MID_Y) > 12 && runner) {
    const near = focus.y < MID_Y ? -1 : 1;
    cands.push(fromTeam(s, team, Math.min(0.95, onsideX), (MID_Y + near * 3) / PITCH_H));
    cands.push(fromTeam(s, team, Math.min(0.93, onsideX), (MID_Y - near * 4) / PITCH_H));
    cands.push(fromTeam(s, team, Math.min(0.89, onsideX), 0.5));
  }
  // Short options either side of the carrier, and a safe ball behind.
  if (sub_ !== 'CB') {
    for (const side of [-1, 1]) {
      cands.push(add(focus, scale(rotate(fwd, side * 0.9), 9)));
      cands.push(add(focus, scale(rotate(fwd, side * 2.1), 8)));
    }
  }

  const oppG = oppGoal(s, team);
  const roleW = (forward ? (sub_ === 'ST' ? 1.2 : sub_ === 'AM' ? 1.1 : 1) : sub_ === 'DM' ? 0.5 : sub_ === 'WB' ? 0.6 : 0.4) * (runner || !forward ? 1 : 0.5);
  const noise = 0.15 + 0.9 * (1 - skill);
  let best = anchor;
  let bestScore = -Infinity;
  for (const raw of cands) {
    let c = clampToPitch(raw, 1.5);
    // Not beyond the offside line before the ball is played.
    const cxRaw = teamX(s, team, c.x);
    if (cxRaw > onsideX) c = fromTeam(s, team, onsideX, c.y / PITCH_H);
    let space = 10;
    let lane = 5;
    for (const o of s.players) {
      if (o.team === team || o.sentOff) continue;
      space = Math.min(space, dist(o.pos, c));
      lane = Math.min(lane, distToSegment(o.pos, focus, c));
    }
    const cx = teamX(s, team, c.x);
    let score = space * 0.3 + lane * 0.4 - (lane < 1.2 ? 2 : 0) + cx * PITCH_W * 0.05 * roleW;
    const dG = dist(c, oppG);
    if (forward && runner && dG < 20) score += (20 - dG) * 0.06;
    for (const m of s.players) {
      if (m.team !== team || m.i === p.i || m.role === 'GK' || m.sentOff) continue;
      const spot = m.i === carrier?.i ? focus : m.ai?.target && m.ai.attacking ? m.ai.target : m.pos;
      const d = dist(c, spot);
      if (d < 9) score -= (9 - d) * (m.i === carrier?.i ? 0.5 : 0.3);
    }
    const dF = dist(c, focus);
    if (dF > 35) score -= (dF - 35) * 0.12;
    score -= dist(p.pos, c) * 0.04 + dist(anchor, c) * (p.role === 'DEF' ? 0.12 : sub_ === 'DM' ? 0.09 : 0.04) * (runner || p.role === 'DEF' ? 1 : 2);
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

/** A tackle on the carrier if he is in range and the moment is right. Keen (pressing) sides go in sooner. */
function tryTackle(s: MatchState, p: MatchPlayer, owner: MatchPlayer, skill: number, k: Tactic): Intent | null {
  const d = dist(p.pos, owner.pos);
  // Good defenders wait until they're in range; poor ones lunge early.
  const range_ = 1.45 + 0.5 * (1 - skill) + k.reach;
  if (d < range_ && p.tackleCd === 0 && p.aiTimer <= 0 && !s.ball.inHands) {
    p.aiTimer = decisionInterval(s, p);
    if (chance(s.rng, clamp((0.35 + 0.35 * p.attrs.defending + 0.15 * skill) * k.tackle, 0, 0.95))) return { move: norm(sub(owner.pos, p.pos)), throttle: 1, action: { kind: 'tackle', target: owner.pos } };
  }
  return null;
}

function defendIntent(s: MatchState, p: MatchPlayer, plan: AiTeamPlan, owner: MatchPlayer | null): Intent {
  const mem = memOf(s, p);
  mem.attacking = false;
  mem.target = null;
  const skill = skillOf(s, p.team);
  const k = tacticOf(s, p.team);
  const lag = reactionLag(skill);
  const own = ownGoal(s, p.team);
  const cap = 0.82 + 0.18 * skill;

  if (owner && p.i === plan.chaser) {
    const seen = sub(owner.pos, scale(owner.vel, lag));
    const d = dist(p.pos, owner.pos);
    if (plan.engage === false) {
      // A low block: hold off a few metres goal-side and show him wide; go in once he comes close.
      const hold = add(seen, scale(norm(add(sub(own, seen), scale(owner.vel, -0.3))), 4.5));
      return seek(p, clampToPitch(hold, 0.8), 1.5, cap);
    }
    const cut = add(add(seen, scale(owner.vel, 0.25)), scale(norm(sub(own, seen)), 0.8));
    const tackle = tryTackle(s, p, owner, skill, k);
    if (tackle) return tackle;
    // A pressing side sprints at the ball wherever it is.
    return { ...seek(p, cut, 1), sprint: sprintOk(s, p, d > 2.5 && (teamX(s, p.team, owner.pos.x) < 0.5 || k.extra >= 2)) };
  }

  // Pressing with the chaser: cut a passing lane, or close the carrier down from the other side.
  const pj = owner && plan.pressers ? plan.pressers.indexOf(p.i) : -1;
  if (owner && pj >= 0) {
    const seen = sub(owner.pos, scale(owner.vel, lag));
    const lane = plan.pressLane![pj];
    let spot: Vec;
    if (lane >= 0) spot = add(seen, scale(sub(s.players[lane].pos, seen), 0.42));
    else if (lane <= -2) {
      // Screening: in the line from the carrier to the middle of our goal, a stride or two off him.
      const j = -2 - lane;
      const toGoal = norm(sub(own, seen));
      spot = add(add(seen, scale(toGoal, 2.4 + 1.6 * j)), scale({ x: -toGoal.y, y: toGoal.x }, j === 0 ? 0 : j % 2 ? 1.1 : -1.1));
      return { ...seek(p, clampToPitch(spot, 0.8), 1, 1), sprint: sprintOk(s, p, dist(p.pos, spot) > 4) };
    } else {
      const ch = plan.chaser >= 0 ? s.players[plan.chaser] : null;
      spot = add(seen, scale(norm(ch ? sub(seen, ch.pos) : sub(seen, own)), 1.3));
    }
    const tackle = tryTackle(s, p, owner, skill, k);
    if (tackle) return tackle;
    return { ...seek(p, clampToPitch(spot, 0.8), 1, 1), sprint: sprintOk(s, p, dist(p.pos, spot) > 3) };
  }

  const bx = teamX(s, p.team, plan.focus.x);
  const holdLine = p.role === 'DEF' && bx > plan.line + 0.04;
  const target = plan.mark[p.i];
  if (target >= 0) {
    const a = s.players[target];
    const seen = add(sub(a.pos, scale(a.vel, lag)), scale(a.vel, 0.15 + 0.2 * skill));
    const goalSide = norm(sub(own, seen));
    const toBall = norm(sub(plan.focus, seen));
    const dGoal = dist(seen, own);
    const tight = clamp(dGoal * 0.08, 1.8, 4) * (1.35 - 0.45 * skill);
    let spot = add(seen, scale(norm(add(scale(goalSide, 0.65), scale(toBall, 0.35))), tight));
    // A defender doesn't follow a runner past the line: that runner is offside.
    if (holdLine && teamX(s, p.team, spot.x) < plan.line) spot = fromTeam(s, p.team, plan.line, spot.y / PITCH_H);
    // Step in to intercept a pass aimed at my man.
    if (!owner && s.ball.receiver === target) {
      const ic = plan.icpt[p.i];
      const theirs = plan.icpt[target];
      if (ic && theirs && ic.t + (1 - skill) * 0.8 < theirs.t + 0.1) return seek(p, ic.pt, 1);
    }
    return seek(p, clampToPitch(spot, 0.8), 1.5, cap);
  }

  if (p.i === plan.cover && skill >= 0.5) {
    // Screen: between the ball and the middle of our goal, in front of the back line.
    const f = plan.focus;
    const spot = add(own, scale(sub(f, own), 0.55));
    const nx = Math.max(teamX(s, p.team, spot.x), plan.line + 0.05);
    return seek(p, fromTeam(s, p.team, nx, clamp(spot.y / PITCH_H, 0.2, 0.8)), 2, cap);
  }
  // Getting back into shape is a jog, not a sprint: that is where counter-attacks find room.
  // A deep or pressing side gets back quicker.
  const home = shapeTarget(s, p, false, plan.focus, plan.line, plan.oppLine);
  return seek(p, home, 3, (dist(home, p.pos) > 10 ? k.recover : 0.9) * cap);
}

// ---------------------------------------------------------------------------
// Restarts: positions

const fromOpp = (s: MatchState, team: 0 | 1, metresFromGoalLine: number, y: number): Vec => ({ x: oppGoal(s, team).x - attackDir(s, team) * metresFromGoalLine, y });

/** Players ranked for attacking a ball in the box: centre-backs and strikers first. */
function aerialRank(p: MatchPlayer): number {
  const base = p.sub === 'CB' ? 3 : p.sub === 'ST' ? 2.8 : p.sub === 'CM' ? 1.4 : p.sub === 'AM' ? 1.25 : p.sub === 'W' || p.sub === 'WM' ? 1.1 : p.sub === 'DM' ? 0.9 : p.sub === 'WB' ? 0.5 : 0.4;
  return base + p.attrs.shooting * 0.5 + p.attrs.defending * 0.3;
}

/** Targets for a set piece into the box: who goes where, and who marks whom. Players already given a target (a wall) keep it. */
function boxSetPiece(s: MatchState, r: Restart, t: (Vec | null)[], attackers: number): void {
  const att = r.team;
  const def: 0 | 1 = att === 0 ? 1 : 0;
  const near = r.spot.y < MID_Y ? -1 : 1;
  const zones: Vec[] = [
    fromOpp(s, att, 6.5, MID_Y + near * 3),
    fromOpp(s, att, 8, MID_Y - near * 3),
    fromOpp(s, att, 11, MID_Y + near * 0.5),
    fromOpp(s, att, 9.5, MID_Y - near * 0.5),
    fromOpp(s, att, 12, MID_Y - near * 6),
    fromOpp(s, att, 9, MID_Y + near * 6),
  ];
  const ours = s.players.filter((p) => p.team === att && !p.sentOff && p.i !== r.taker && p.role !== 'GK' && !t[p.i]).sort((a, b) => aerialRank(b) - aerialRank(a));
  const inBox: number[] = [];
  ours.forEach((p, k) => {
    if (k < attackers) {
      t[p.i] = zones[k % zones.length];
      inBox.push(p.i);
    } else if (k < attackers + 2) t[p.i] = fromOpp(s, att, 20, MID_Y + (k % 2 ? 9 : -9)); // edge of the box, for the second ball
    else t[p.i] = fromTeam(s, att, 0.55, k % 2 ? 0.35 : 0.65); // rest defence
  });
  // Defending: keeper on his line, one on the near post, mark the men in the box, someone on the edge, the forwards stay up.
  const gk = goalkeeper(s, def);
  if (!t[gk.i]) t[gk.i] = { x: ownGoal(s, def).x + attackDir(s, def) * 0.6, y: MID_Y + near * 0.8 };
  const theirs = s.players.filter((p) => p.team === def && !p.sentOff && p.i !== gk.i && !t[p.i]);
  const used = new Set<number>();
  const postMan = theirs.filter((p) => p.sub === 'FB' || p.sub === 'WB').sort((a, b) => dist(a.pos, r.spot) - dist(b.pos, r.spot))[0];
  if (postMan && r.kind === 'corner') {
    t[postMan.i] = { x: ownGoal(s, def).x + attackDir(s, def) * 0.5, y: MID_Y + near * (GOAL_W / 2 - 0.3) };
    used.add(postMan.i);
  }
  for (const ai of inBox) {
    const a = t[ai]!;
    let best: MatchPlayer | null = null;
    for (const d of theirs) {
      if (used.has(d.i) || d.sub === 'ST') continue;
      if (!best || aerialRank(d) - dist(d.pos, a) * 0.05 > aerialRank(best) - dist(best.pos, a) * 0.05) best = d;
    }
    if (!best) break;
    used.add(best.i);
    // Goal-side and a touch toward the ball.
    t[best.i] = add(a, scale(norm(add(sub(ownGoal(s, def), a), scale(sub(r.spot, a), 0.15))), 1.1));
  }
  let k = 0;
  for (const d of theirs) {
    if (used.has(d.i)) continue;
    if (d.sub === 'ST') t[d.i] = fromTeam(s, def, 0.42, k++ % 2 ? 0.4 : 0.6);
    else t[d.i] = add(fromOpp(s, att, 14 + (k % 2) * 4, MID_Y + ((k++ % 3) - 1) * 8), { x: 0, y: 0 });
  }
}

/** A defensive wall 9.15 m from the ball, covering the near side of the goal. */
function wall(s: MatchState, r: Restart, t: (Vec | null)[], n: number): number[] {
  const def: 0 | 1 = r.team === 0 ? 1 : 0;
  const goal = ownGoal(s, def);
  const nearPost = { x: goal.x, y: MID_Y + Math.sign(r.spot.y - MID_Y || 1) * (GOAL_W / 2 - 1) };
  const aim = norm(sub(add(scale(goal, 0.4), scale(nearPost, 0.6)), r.spot));
  const centre = add(r.spot, scale(aim, RETREAT + 0.4));
  const perp = { x: -aim.y, y: aim.x };
  const cands = s.players.filter((p) => p.team === def && !p.sentOff && p.role !== 'GK' && p.sub !== 'CB').sort((a, b) => dist(a.pos, centre) - dist(b.pos, centre));
  const picked = cands.slice(0, n).map((p) => p.i);
  picked.forEach((i, k) => (t[i] = add(centre, scale(perp, (k - (n - 1) / 2) * 0.75))));
  // Keeper: on the far side of the wall, a couple of metres off his line.
  const gk = goalkeeper(s, def);
  t[gk.i] = { x: goal.x + attackDir(s, def) * 1, y: MID_Y - Math.sign(r.spot.y - MID_Y || 1) * 1.2 };
  return picked;
}

function buildRestartTargets(s: MatchState, r: Restart): (Vec | null)[] {
  const t: (Vec | null)[] = s.players.map(() => null);
  const att = r.team;
  const def: 0 | 1 = att === 0 ? 1 : 0;
  const ax = teamX(s, att, r.spot.x);
  const shape = (team: 0 | 1, attacking: boolean) => {
    const plan = teamPlan(s, team);
    for (const p of s.players) {
      if (p.team !== team || p.sentOff || t[p.i]) continue;
      t[p.i] = shapeTarget(s, p, attacking, r.spot, plan.line, Math.max(plan.oppLine, 0.5));
    }
  };
  const gkHome = (team: 0 | 1) => {
    const gk = goalkeeper(s, team);
    if (!t[gk.i]) t[gk.i] = add(ownGoal(s, team), { x: attackDir(s, team) * 1.5, y: 0 });
  };
  switch (r.kind) {
    case 'corner':
      boxSetPiece(s, r, t, 4 + (skillOf(s, att) > 0.6 ? 1 : 0));
      break;
    case 'freekick': {
      const dGoal = dist(r.spot, oppGoal(s, att));
      const wideFinal = ax > 0.7 && Math.abs(r.spot.y - MID_Y) > BOX_W / 2 - 3;
      if (r.direct && dGoal < 30 && !wideFinal) {
        wall(s, r, t, dGoal < 20 ? 4 : dGoal < 25 ? 3 : 2);
        boxSetPiece(s, r, t, 3);
      } else if (ax > 0.62) boxSetPiece(s, r, t, ax > 0.7 ? 4 : 3);
      break;
    }
    case 'penalty': {
      // Everyone around the edge of the area, behind the mark.
      let k = 0;
      for (const p of s.players) {
        if (p.sentOff || p.i === r.taker) continue;
        if (p.team === def && p.role === 'GK') {
          t[p.i] = { x: ownGoal(s, def).x, y: MID_Y };
          continue;
        }
        const slotY = ((k++ % 8) - 3.5) * 4.2;
        t[p.i] = fromOpp(s, att, BOX_DEPTH + 1.5 + (Math.abs(slotY) < 9 ? 2.5 : 0), MID_Y + slotY);
      }
      break;
    }
    case 'throwin': {
      // Two teammates come short; the rest hold the shape around it.
      const inward = r.spot.y < MID_Y ? 1 : -1;
      const mates = s.players.filter((p) => p.team === att && !p.sentOff && p.i !== r.taker && p.role !== 'GK').sort((a, b) => dist(a.pos, r.spot) - dist(b.pos, r.spot));
      const dir = attackDir(s, att);
      if (mates[0]) t[mates[0].i] = clampToPitch({ x: r.spot.x + dir * 7, y: r.spot.y + inward * 4 }, 1);
      if (mates[1]) t[mates[1].i] = clampToPitch({ x: r.spot.x - dir * 4, y: r.spot.y + inward * 9 }, 1);
      break;
    }
    case 'goalkick': {
      // Centre-backs split to the corners of the box, full-backs wide: an outlet to the side.
      for (const p of s.players) {
        if (p.team !== att || p.sentOff || p.i === r.taker) continue;
        const sl = slotOf(s, p);
        if (p.sub === 'CB') t[p.i] = fromTeam(s, att, 0.11, sl.y < 0.5 ? 0.26 : 0.74);
        else if (p.sub === 'FB' || p.sub === 'WB') t[p.i] = fromTeam(s, att, 0.22, sl.y < 0.5 ? 0.05 : 0.95);
        else if (p.sub === 'DM') t[p.i] = fromTeam(s, att, 0.25, 0.5);
      }
      // Opponents push up, but outside the area.
      for (const p of s.players) {
        if (p.team !== def || p.sentOff || p.role === 'GK') continue;
        if (p.sub === 'ST' || p.sub === 'W') {
          const sl = slotOf(s, p);
          t[p.i] = fromTeam(s, att, (BOX_DEPTH + 2) / PITCH_W, 0.5 + (sl.y - 0.5) * 0.7);
        }
      }
      break;
    }
    case 'kickoff':
      break;
  }
  shape(att, true);
  shape(def, false);
  gkHome(att);
  gkHome(def);
  return t;
}

/** Where a CPU player goes during a restart (not the taker). */
export function restartIntent(s: MatchState, p: MatchPlayer): Intent {
  const r = s.restart;
  if (!r || p.sentOff) return IDLE;
  const key = s.tick - (s.tick % 15);
  let cache = s.aiRestart;
  if (!cache || cache.key !== key || cache.kind !== r.kind || cache.team !== r.team) {
    cache = { key, kind: r.kind, team: r.team, targets: buildRestartTargets(s, r) };
    s.aiRestart = cache;
  }
  const target = cache.targets[p.i];
  if (!target) return IDLE;
  const d = dist(p.pos, target);
  const it = seek(p, target, 2, r.stage === 'whistle' ? 0.65 : 1);
  return { ...it, sprint: d > 18 && r.stage !== 'whistle' && sprintOk(s, p, true) };
}

// ---------------------------------------------------------------------------
// Restarts: what the CPU taker does

/** A lofted ball landing on `target`. */
const loft = (s: MatchState, target: Vec): Action => ({ kind: 'chip', target, power: chipPowerFor(dist(s.ball.pos, target)) });

/**
 * The CPU taker's choice for the restart in progress. The taker is already
 * over the ball; match.ts plays it with this Action.
 */
export function restartAction(s: MatchState, p: MatchPlayer): Action {
  const r = s.restart!;
  const skill = skillOf(s, p.team);
  const noise = 0.2 + 0.4 * (1 - skill);
  const team = p.team;
  const dir = attackDir(s, team);
  const goal = oppGoal(s, team);
  const ax = teamX(s, team, r.spot.x);
  const passOpt = (maxD: number): PassOption | null => {
    let best: PassOption | null = null;
    for (const m of s.players) {
      if (m.team !== team || m.i === p.i || m.sentOff) continue;
      const target = leadTarget(r.spot, m, p.attrs.passing);
      if (dist(target, r.spot) > maxD) continue;
      const sc = evalPass(s, p, m, target, false);
      if (sc === -Infinity) continue;
      const score = sc + gauss(s.rng) * noise;
      if (!best || score > best.score) best = { receiver: m, target, score, through: false };
    }
    return best;
  };
  const toPass = (o: PassOption): Action => ({ kind: 'pass', target: o.target, receiver: o.receiver.i });

  switch (r.kind) {
    case 'kickoff': {
      const o = passOpt(20);
      return o ? toPass(o) : { kind: 'pass', target: add(r.spot, { x: -dir * 8, y: 4 }), receiver: -1 };
    }
    case 'throwin': {
      const o = passOpt(22);
      // A long throw into the box from close to the corner.
      if (ax > 0.82 && chance(s.rng, 0.3 + 0.2 * p.attrs.passing)) {
        const c = bestCross(s, p, noise);
        if (c && dist(c.target, r.spot) < 28) return loft(s, c.target);
      }
      if (o && o.score > -1) return toPass(o);
      // Nothing short: down the line.
      const inward = r.spot.y < MID_Y ? 1 : -1;
      return loft(s, clampToPitch({ x: r.spot.x + dir * 18, y: r.spot.y + inward * 6 }, 2));
    }
    case 'goalkick': {
      const o = passOpt(30);
      if (o && o.score > 0.3 && (o.receiver.role === 'DEF' || o.receiver.sub === 'DM') && chance(s.rng, 0.4 + 0.5 * skill)) return toPass(o);
      // Long: to a forward or the flank, around halfway.
      const fwds = s.players.filter((m) => m.team === team && !m.sentOff && (m.role === 'FWD' || m.sub === 'WM'));
      const tgt = fwds.length ? fwds[Math.floor(next(s.rng) * fwds.length)].pos : fromTeam(s, team, 0.55, 0.5);
      return loft(s, clampToPitch({ x: clamp(tgt.x, 20, PITCH_W - 20), y: tgt.y }, 4));
    }
    case 'corner': {
      // Mostly into the box; now and then short to an unmarked teammate.
      const shortMate = s.players.find((m) => m.team === team && !m.sentOff && m.i !== p.i && dist(m.pos, r.spot) < 14 && dist(m.pos, r.spot) > 4);
      if (shortMate && skill > 0.55 && chance(s.rng, 0.12)) return { kind: 'pass', target: shortMate.pos, receiver: shortMate.i };
      const c = bestCross(s, p, noise);
      const near = r.spot.y < MID_Y ? -1 : 1;
      const target = c ? c.target : fromOpp(s, team, 7, MID_Y + near * 1);
      return loft(s, target);
    }
    case 'penalty': {
      const r2 = next(s.rng);
      const side = r2 < 0.43 ? -1 : r2 < 0.86 ? 1 : 0;
      const y = MID_Y + side * (GOAL_W / 2 - 0.5 - 0.4 * (1 - p.attrs.shooting));
      return { kind: 'shoot', target: { x: goal.x, y }, power: 0.72 + 0.12 * p.attrs.shooting, lift: range(s.rng, 0, 2.2) };
    }
    case 'freekick': {
      const dGoal = dist(r.spot, goal);
      if (inOwnBox(s, team, r.spot) || ax < 0.3) {
        const o = passOpt(25);
        if (o && o.score > 0) return toPass(o);
        return clearance(s, p, range(s.rng, 45, 58));
      }
      const angleOk = Math.abs(r.spot.y - MID_Y) < 14 + (30 - dGoal) * 0.3;
      if (r.direct && dGoal < 29 && dGoal > 15 && angleOk && chance(s.rng, 0.35 + 0.5 * p.attrs.shooting)) {
        // Over the wall and dipping under the bar.
        const yAim = MID_Y + (r.spot.y < MID_Y ? 1 : -1) * (GOAL_W / 2 - 0.8) * (chance(s.rng, 0.6) ? 1 : -1);
        const speed = (13 + 17 * 0.82) * (0.8 + 0.3 * p.attrs.shooting);
        const tWall = RETREAT / (speed * 0.98);
        const tGoal = dGoal / (speed * 0.95);
        // Rising as it passes the wall (a jumping wall only heads a ball on its way down), dipping to about 1.7 m at the line.
        const vz = clamp((1.7 + 0.5 * GRAVITY * tGoal * tGoal) / tGoal, (1.4 + 0.5 * GRAVITY * tWall * tWall) / tWall, 20);
        return { kind: 'shoot', target: { x: goal.x, y: yAim }, power: 0.82, lift: vz };
      }
      if (ax > 0.66) {
        const c = bestCross(s, p, noise);
        if (c) return loft(s, c.target);
      }
      const o = passOpt(35);
      if (o && o.score > -0.5) return toPass(o);
      return loft(s, clampToPitch(add(r.spot, { x: dir * 30, y: 0 }), 4));
    }
  }
}

// ---------------------------------------------------------------------------

export function aiIntent(s: MatchState, p: MatchPlayer): Intent {
  if (p.stun > 0 || p.sentOff) return IDLE;
  p.aiTimer--;
  if (--p.jitterTimer <= 0) {
    p.jitterTimer = 60 + Math.floor(next(s.rng) * 60);
    p.jitter = { x: range(s.rng, -0.04, 0.04), y: range(s.rng, -0.05, 0.05) };
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
    const run = dist(target, p.pos) > 8 && teamX(s, p.team, target.x) > teamX(s, p.team, p.pos.x) + 0.08;
    return { ...seek(p, target, 2.5, runCap), sprint: sprintOk(s, p, run) };
  }
  return defendIntent(s, p, plan, owner && owner.team !== p.team ? owner : null);
}
