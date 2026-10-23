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

/** Ball flight. Metres and seconds, so gravity is the real thing. */
export const GRAVITY = 9.8;
export const BOUNCE_DAMP = 0.55;
/** Above this height a ball cannot be taken by an outfield player. */
export const REACH_Z = 1.2;
/** Keepers can leap for it, but only inside their box and below this height. */
export const KEEPER_REACH_Z = 2.1;
/** Crossbar height: a ball arriving higher than this over the line is not a goal. */
export const GOAL_BAR_H = 2.2;

/** A chip leaves the foot already above the floor, so a defender at point-blank range cannot just take it. */
export const CHIP_Z0 = 1.3;

export const SPRINT_MULT = 1.18;
/** Energy per second burned while sprinting, scaled by stamina. */
export const SPRINT_DRAIN = 0.055;
export const WINDED_BELOW = 0.44;
export const WINDED_RECOVER = 0.58;

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

/** Horizontal drag on a ball in the air, per second (much weaker than floor friction). */
export const AIR_DRAG = 0.12;
