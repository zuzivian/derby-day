import { BOX_DEPTH, BOX_W, GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W } from './constants.ts';
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

export function inOwnBox(team: 0 | 1, p: Vec): boolean {
  const nx = teamX(team, p.x) * PITCH_W;
  return nx <= BOX_DEPTH && Math.abs(p.y - PITCH_H / 2) <= BOX_W / 2;
}

export const inGoalMouth = (y: number): boolean => y > GOAL_TOP && y < GOAL_BOTTOM;

export function teammates(s: MatchState, p: MatchPlayer): MatchPlayer[] {
  return s.players.filter((m) => m.team === p.team && m.i !== p.i);
}

export function opponents(s: MatchState, team: 0 | 1): MatchPlayer[] {
  return s.players.filter((m) => m.team !== team);
}

export function nearestOpponentDist(s: MatchState, p: MatchPlayer): number {
  let best = Infinity;
  for (const o of s.players) if (o.team !== p.team) best = Math.min(best, dist(o.pos, p.pos));
  return best;
}

export function goalkeeper(s: MatchState, team: 0 | 1): MatchPlayer {
  return s.players.find((p) => p.team === team && p.role === 'GK')!;
}

export function clampToPitch(p: Vec, margin: number): Vec {
  return {
    x: Math.min(PITCH_W - margin, Math.max(margin, p.x)),
    y: Math.min(PITCH_H - margin, Math.max(margin, p.y)),
  };
}
