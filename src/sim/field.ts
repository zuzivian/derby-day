import { BOX_DEPTH, BOX_W, formationOf, GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W, SIX_DEPTH, SIX_W, type FormationSlot } from './constants.ts';
import type { MatchPlayer, MatchState } from './types.ts';
import { dist, type Vec } from './vec.ts';

/**
 * Which half it is: everything about direction depends on it, because the teams change ends
 * at half-time (Law 8). A MatchState, or anything else that knows the half.
 */
export type HalfOf = Pick<MatchState, 'half'>;

/** The end `team` defends this half: 0 is the goal at x = 0, 1 the goal at x = PITCH_W. Team 0 starts at x = 0. */
export const endOf = (s: HalfOf, team: 0 | 1): 0 | 1 => (s.half === 2 ? (team === 0 ? 1 : 0) : team);

/** The team defending the goal at this end this half (0: the goal at x = 0). */
export const teamAtEnd = (s: HalfOf, end: 0 | 1): 0 | 1 => endOf(s, end);

/** +1 if `team` attacks toward x = PITCH_W this half, -1 toward x = 0. */
export const attackDir = (s: HalfOf, team: 0 | 1): number => (endOf(s, team) === 0 ? 1 : -1);

/** World x to 0..1 measured from this team's own goal toward the opponent's. */
export const teamX = (s: HalfOf, team: 0 | 1, x: number): number => (endOf(s, team) === 0 ? x / PITCH_W : 1 - x / PITCH_W);

export const fromTeam = (s: HalfOf, team: 0 | 1, nx: number, ny: number): Vec => ({
  x: endOf(s, team) === 0 ? nx * PITCH_W : (1 - nx) * PITCH_W,
  y: ny * PITCH_H,
});

export const oppGoal = (s: HalfOf, team: 0 | 1): Vec => ({ x: endOf(s, team) === 0 ? PITCH_W : 0, y: PITCH_H / 2 });
export const ownGoal = (s: HalfOf, team: 0 | 1): Vec => ({ x: endOf(s, team) === 0 ? 0 : PITCH_W, y: PITCH_H / 2 });

/** Inside `team`'s own penalty area (lines included). */
export function inOwnBox(s: HalfOf, team: 0 | 1, p: Vec): boolean {
  const nx = teamX(s, team, p.x) * PITCH_W;
  return nx >= -0.5 && nx <= BOX_DEPTH && Math.abs(p.y - PITCH_H / 2) <= BOX_W / 2;
}

/** Inside `team`'s own goal area. */
export function inOwnSix(s: HalfOf, team: 0 | 1, p: Vec): boolean {
  const nx = teamX(s, team, p.x) * PITCH_W;
  return nx >= -0.5 && nx <= SIX_DEPTH && Math.abs(p.y - PITCH_H / 2) <= SIX_W / 2;
}

export const inGoalMouth = (y: number): boolean => y > GOAL_TOP && y < GOAL_BOTTOM;

/** On the field of play (lines are part of it). */
export const onPitch = (p: Vec): boolean => p.x >= 0 && p.x <= PITCH_W && p.y >= 0 && p.y <= PITCH_H;

/** The formation slot a player started in. */
export function slotOf(s: MatchState, p: MatchPlayer): FormationSlot {
  return formationOf(s.teams[p.team].formation)[p.slot];
}

export function teammates(s: MatchState, p: MatchPlayer): MatchPlayer[] {
  return s.players.filter((m) => m.team === p.team && m.i !== p.i && !m.sentOff);
}

export function opponents(s: MatchState, team: 0 | 1): MatchPlayer[] {
  return s.players.filter((m) => m.team !== team && !m.sentOff);
}

export function nearestOpponentDist(s: MatchState, p: MatchPlayer): number {
  let best = Infinity;
  for (const o of s.players) if (o.team !== p.team && !o.sentOff) best = Math.min(best, dist(o.pos, p.pos));
  return best;
}

export function goalkeeper(s: MatchState, team: 0 | 1): MatchPlayer {
  return s.players.find((p) => p.team === team && p.role === 'GK' && !p.sentOff) ?? s.players.find((p) => p.team === team && !p.sentOff) ?? s.players[team === 0 ? 0 : s.players.length - 1];
}

export function clampToPitch(p: Vec, margin: number): Vec {
  return {
    x: Math.min(PITCH_W - margin, Math.max(margin, p.x)),
    y: Math.min(PITCH_H - margin, Math.max(margin, p.y)),
  };
}

/**
 * Law 11: the second-last opponent of an attacking team, as that team's x
 * (0..1 toward the goal it attacks). Usually the last outfield defender, the
 * keeper being the last. Counts players sent off as gone.
 */
export function secondLastOpponentX(s: MatchState, team: 0 | 1): number {
  let a = -1;
  let b = -1;
  for (const o of s.players) {
    if (o.team === team || o.sentOff) continue;
    const x = teamX(s, team, o.pos.x);
    if (x > a) {
      b = a;
      a = x;
    } else if (x > b) b = x;
  }
  return Math.max(0, b);
}

/**
 * Law 11: is player m in an offside position right now? In the opponents'
 * half, and nearer their goal line than both the ball and the second-last
 * opponent. Level is onside.
 */
export function inOffsidePosition(s: MatchState, m: MatchPlayer, ballX = s.ball.pos.x, secondLast = secondLastOpponentX(s, m.team)): boolean {
  const LEVEL = 0.05 / PITCH_W;
  const x = teamX(s, m.team, m.pos.x);
  return x > 0.5 && x > teamX(s, m.team, ballX) + LEVEL && x > secondLast + LEVEL;
}
