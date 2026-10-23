// World units are metres. Indoor six-a-side arena with boards on every side
// except the goal mouths, so the ball stays in play and matches stay fast.

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

export const PITCH_W = 64;
export const PITCH_H = 40;
export const GOAL_W = 6;
export const GOAL_DEPTH = 1.6;
export const GOAL_TOP = (PITCH_H - GOAL_W) / 2;
export const GOAL_BOTTOM = (PITCH_H + GOAL_W) / 2;
export const BOX_DEPTH = 7;
export const BOX_W = 16;

export const PLAYER_R = 0.65;
export const BALL_R = 0.22;
export const TEAM_SIZE = 6;

/** Default real-time length of one half, in seconds. Shown as 45 match minutes. */
export const HALF_SECONDS = 120;

export const KICKOFF_PAUSE = 50;
export const GOAL_PAUSE = 130;
export const HALFTIME_PAUSE = 120;

export type Role = 'GK' | 'DEF' | 'MID' | 'FWD';

/** Formation 1-2-2-1. x runs from own goal (0) to the opponent's goal (1). */
export const FORMATION: { role: Role; x: number; y: number }[] = [
  { role: 'GK', x: 0.03, y: 0.5 },
  { role: 'DEF', x: 0.2, y: 0.3 },
  { role: 'DEF', x: 0.2, y: 0.7 },
  { role: 'MID', x: 0.42, y: 0.22 },
  { role: 'MID', x: 0.42, y: 0.78 },
  { role: 'FWD', x: 0.62, y: 0.5 },
];
