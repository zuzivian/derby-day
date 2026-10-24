import { BOX_DEPTH, BOX_W, formationOf, GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W, SIX_DEPTH, SIX_W, type FormationSlot } from './constants.ts';
import type { MatchPlayer, MatchState } from './types.ts';
import { dist, type Vec } from './vec.ts';

/** Team 0 attacks toward x = PITCH_W, team 1 toward x = 0. */
export const attackDir = (team: 0 | 1): number => (team === 0 ? 1 : -1);

/** World x to 0..1 measured from this team's own goal toward the opponent's. */
export const teamX = (team: 0 | 1, x: number): number => (team === 0 ? x / PITCH_W : 1 - x / PITCH_W);

export const fromTeam = (team: 0 | 1, nx: number, ny: number): Vec => ({
  x: team === 0 ? nx * PITCH_W : (1 - nx) * PITCH_W,
  y: ny * PITCH_H,
});

export const oppGoal = (team: 0 | 1): Vec => ({ x: team === 0 ? PITCH_W : 0, y: PITCH_H / 2 });
export const ownGoal = (team: 0 | 1): Vec => ({ x: team === 0 ? 0 : PITCH_W, y: PITCH_H / 2 });

/** Inside `team`'s own penalty area (lines included). */
export function inOwnBox(team: 0 | 1, p: Vec): boolean {
  const nx = teamX(team, p.x) * PITCH_W;
  return nx >= -0.5 && nx <= BOX_DEPTH && Math.abs(p.y - PITCH_H / 2) <= BOX_W / 2;
}

/** Inside `team`'s own goal area. */
export function inOwnSix(team: 0 | 1, p: Vec): boolean {
  const nx = teamX(team, p.x) * PITCH_W;
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
    const x = teamX(team, o.pos.x);
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
  const x = teamX(m.team, m.pos.x);
  return x > 0.5 && x > teamX(m.team, ballX) + LEVEL && x > secondLast + LEVEL;
}
