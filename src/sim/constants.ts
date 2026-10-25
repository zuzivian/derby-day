// World units are metres. Eleven-a-side on a full-size pitch with the Laws of
// the Game markings: the ball goes out of play over the touchlines and goal
// lines (no boards), so throw-ins, goal kicks and corners restart play.
//
// Coordinates: x runs along the pitch from team 0's goal line (x = 0) to team
// 1's (x = PITCH_W); y runs across it from one touchline (y = 0) to the other.

/**
 * Bumped whenever a change makes the sim produce a different match from the
 * same seed and inputs. Replays carry it, so one recorded on another version
 * is flagged instead of silently showing a different match.
 *   1  six-a-side on boards (until 2026-10)
 *   2  eleven-a-side, full pitch, Laws 8, 11, 12, 13-17 (restarts, offside, fouls, cards)
 *   3  ball physics by height (control, chest, headers, bounces off bodies), keeper dives,
 *      catches and parries, firm click passes with assist, the human's keeper and first-time kicks
 *   4  Law 12: opponents standing close can't touch the keeper's release
 *   5  nine formations and five mentalities that change how the CPU defends,
 *      presses and supports the ball (src/sim/ai.ts TACTICS); CPU shot selection and
 *      long-shot error; mentality changes from the pause menu (HumanInput.tactic)
 *   6  controls feel: no hold on a steered man's pickup, tackles by the carrier's distance and slides
 *      judged as they travel, lofts with a receiver and a softer bounce, rising human shots,
 *      header aim relative to the striker, restart clicks kept, double clicks ignored
 *   7  the Laws, done properly: teams change ends at half-time; the kick-off is a kick; no second
 *      touch by a restart taker, nor keeper handling of his own goal kick or release; offside
 *      judged again on a teammate's header or deflection; a header to the keeper is no back-pass;
 *      a late challenge after a shot lets the shot play out; advantage stands once it ensued;
 *      added time; a side below seven abandons the match
 *   8  a parry never goes in between the posts; a long or blocked corner pass is crossed
 *   9  the ball is swept against the posts and the crossbar: a hard shot no longer passes through them
 *  10  off the ball: the front striker stays on the last defender's shoulder (not a short
 *      supporter) until the final third, and forwards on the shoulder follow the line
 *  11  a keeper claiming a high ball gets under it where it drops to catching height; a better keeper comes further for one
 *  12  a click up to 4 m off a team-mate picks him; an automatic switch keeps its man 0.75 s and never leaves a man the ball is coming to
 *  13  a click into the path of a running team-mate is a ball for him, timed to his run; he takes it in stride
 *  14  a back five forms: defenders leave a man 10 m upfield of their place to the midfield,
 *      and one 8 m or more upfield of his place runs back instead of jogging
 *  15  free kicks: a wall formed 9.15 m off before the kick, standing still and jumping as it is
 *      struck; strikes over it with dip and curl (HumanInput.curl), too much pace goes over; the
 *      kicking side keeps out of its shooting lane; a quick free kick before the wall is set
 *  16  corners: a cross comes down where it was aimed, driven or floated by the hold and bent by a drag;
 *      a man comes short; the box waits out of its zones and attacks them as it is struck; markers
 *      challenge in the air; a keeper comes for a floated ball into his six-yard box
 */
export const SIM_VERSION = 16;

export const TICK_HZ = 60;

/**
 * Extra spread on a shot (radians) per metre beyond 16 m from goal (up to 30 m: further out a
 * strike is a long ball more than a shot), times (1.3 - shooting).
 * Real football scores about 4% of shots from 18-30 m; without it a shot from 25 m was as
 * well placed as one from the penalty spot. The ball physics and the keepers are in match.ts.
 */
export const LONG_SHOT_ERR = 0.01;
export const DT = 1 / TICK_HZ;

export const PITCH_W = 105;
export const PITCH_H = 68;
/** Inside of the posts. */
export const GOAL_W = 7.32;
export const GOAL_DEPTH = 2;
export const GOAL_TOP = (PITCH_H - GOAL_W) / 2;
export const GOAL_BOTTOM = (PITCH_H + GOAL_W) / 2;
/** Penalty area: 16.5 m from the goal line, 16.5 m either side of the posts. */
export const BOX_DEPTH = 16.5;
export const BOX_W = GOAL_W + 2 * 16.5;
/** Goal area: 5.5 m deep, 5.5 m either side of the posts. */
export const SIX_DEPTH = 5.5;
export const SIX_W = GOAL_W + 2 * 5.5;
/** Penalty mark, from the goal line. */
export const PENALTY_SPOT = 11;
/** Centre circle radius, penalty arc radius, and the free-kick / corner distance. */
export const CENTRE_R = 9.15;
export const RETREAT = 9.15;
export const CORNER_R = 1;

export const PLAYER_R = 0.65;
export const BALL_R = 0.11;
export const TEAM_SIZE = 11;
/** Squad size of a generated club: 11 starters and 7 on the bench. */
export const SQUAD_SIZE = 18;

/** Default real-time length of one half, in seconds. Shown as 45 match minutes. */
export const HALF_SECONDS = 180;
/** Match seconds shown on a 90-minute clock. */
export const MATCH_SECONDS = 90 * 60;

/** Ball flight. Metres and seconds, so gravity is the real thing. */
export const GRAVITY = 9.8;
export const BOUNCE_DAMP = 0.55;
/** Share of its pace across the ground a ball keeps when it bounces on grass (a lofted pass sits up, not skids on). */
export const BOUNCE_KEEP = 0.65;
/** Above this height a ball cannot be controlled by an outfield player (headers go up to HEAD_Z). */
export const REACH_Z = 1.2;
/** A descending ball below this can be headed. */
export const HEAD_Z = 2.5;
/** Keepers can leap for it, but only inside their box and below this height. */
export const KEEPER_REACH_Z = 2.6;
/** Crossbar height (underside): a ball higher than this over the line is not a goal. */
export const GOAL_BAR_H = 2.44;
/** Players may run this far beyond the lines (to take a throw-in or a corner). */
export const RUN_OFF = 3;

/** A chip leaves the foot already above the floor, so a defender at point-blank range cannot just take it. */
export const CHIP_Z0 = 1.3;
/** A throw-in leaves the hands above the head. */
export const THROW_Z0 = 2.0;

export const SPRINT_MULT = 1.18;
/** Energy per second burned while sprinting, scaled by stamina. */
export const SPRINT_DRAIN = 0.055;
export const WINDED_BELOW = 0.44;
export const WINDED_RECOVER = 0.58;

export const KICKOFF_PAUSE = 50;
export const GOAL_PAUSE = 130;
export const HALFTIME_PAUSE = 120;

/** Restart timing, ticks. See rules.ts for the state machine. */
export const RESTART_WHISTLE = 30;
export const RESTART_WHISTLE_FOUL = 55;
export const RESTART_SETUP_MIN = 24;
export const RESTART_SETUP_MAX = 210;
/** A human taker who does nothing for this long has the CPU take it for them. */
export const RESTART_HUMAN_WAIT = 300;
/** How long the referee waits to see whether an advantage comes to anything. */
export const ADVANTAGE_TICKS = 120;

export type Role = 'GK' | 'DEF' | 'MID' | 'FWD';
/**
 * Finer positions inside a role, what the CPU (src/sim/ai.ts) plays to:
 *   CB  centre-back: holds the line          FB  full-back: overlaps on the ball side
 *   WB  wing-back: the width in a back three or five, higher than a full-back
 *   DM  holding midfielder: screens the back line   CM  central midfielder: box to box
 *   AM  attacking midfielder or second striker: between the lines
 *   WM  wide midfielder: tracks back into a four    W   winger: stays high and wide
 *   ST  striker: on the last defender's shoulder
 */
export type SubRole = 'GK' | 'CB' | 'FB' | 'WB' | 'DM' | 'CM' | 'AM' | 'WM' | 'W' | 'ST';
/** Order matters: replays store the index into FORMATION_IDS, so new formations go on the end. */
export type FormationId = '4-4-2' | '4-3-3' | '4-2-3-1' | '4-1-4-1' | '4-4-1-1' | '3-5-2' | '3-4-3' | '5-3-2' | '5-4-1';

export interface FormationSlot {
  role: Role;
  sub: SubRole;
  /** Short label for a lineup board, e.g. "LB". */
  label: string;
  /** Base shape in team coordinates: x from own goal line (0) to the opponent's (1), y across (0..1). */
  x: number;
  y: number;
}

const GK_SLOT: FormationSlot = { role: 'GK', sub: 'GK', label: 'GK', x: 0.02, y: 0.5 };
/** Back four: full-backs a touch higher than the centre-backs. */
const BACK_FOUR: FormationSlot[] = [
  { role: 'DEF', sub: 'FB', label: 'LB', x: 0.2, y: 0.13 },
  { role: 'DEF', sub: 'CB', label: 'CB', x: 0.18, y: 0.39 },
  { role: 'DEF', sub: 'CB', label: 'CB', x: 0.18, y: 0.61 },
  { role: 'DEF', sub: 'FB', label: 'RB', x: 0.2, y: 0.87 },
];
/** Back three; the wing-backs are added per formation (high in a 3-5-2, on the line in a 5-3-2). */
const BACK_THREE: FormationSlot[] = [
  { role: 'DEF', sub: 'CB', label: 'CB', x: 0.17, y: 0.3 },
  { role: 'DEF', sub: 'CB', label: 'CB', x: 0.16, y: 0.5 },
  { role: 'DEF', sub: 'CB', label: 'CB', x: 0.17, y: 0.7 },
];
const wingBacks = (x: number): [FormationSlot, FormationSlot] => [
  { role: 'DEF', sub: 'WB', label: 'LWB', x, y: 0.08 },
  { role: 'DEF', sub: 'WB', label: 'RWB', x, y: 0.92 },
];
const TWO_STRIKERS: FormationSlot[] = [
  { role: 'FWD', sub: 'ST', label: 'ST', x: 0.58, y: 0.37 },
  { role: 'FWD', sub: 'ST', label: 'ST', x: 0.58, y: 0.63 },
];
const LONE_STRIKER: FormationSlot = { role: 'FWD', sub: 'ST', label: 'ST', x: 0.6, y: 0.5 };
/** A flat midfield four: wide men, a holding and a central midfielder. */
const MID_FOUR: FormationSlot[] = [
  { role: 'MID', sub: 'WM', label: 'LM', x: 0.4, y: 0.12 },
  { role: 'MID', sub: 'DM', label: 'CM', x: 0.36, y: 0.4 },
  { role: 'MID', sub: 'CM', label: 'CM', x: 0.4, y: 0.6 },
  { role: 'MID', sub: 'WM', label: 'RM', x: 0.4, y: 0.88 },
];
/** A midfield three: one holding, two central. */
const MID_THREE = (dmX: number, cmX: number, cmY = 0.33): FormationSlot[] => [
  { role: 'MID', sub: 'DM', label: 'DM', x: dmX, y: 0.5 },
  { role: 'MID', sub: 'CM', label: 'CM', x: cmX, y: cmY },
  { role: 'MID', sub: 'CM', label: 'CM', x: cmX, y: 1 - cmY },
];

/**
 * Every slot list runs keeper, defence, midfield, attack. Lineups are stored
 * in slot order, so a formation's slots are never reordered once shipped.
 */
export const FORMATIONS: Record<FormationId, FormationSlot[]> = {
  '4-4-2': [GK_SLOT, ...BACK_FOUR, ...MID_FOUR, ...TWO_STRIKERS],
  '4-3-3': [
    GK_SLOT,
    ...BACK_FOUR,
    ...MID_THREE(0.32, 0.42),
    { role: 'FWD', sub: 'W', label: 'LW', x: 0.58, y: 0.12 },
    { role: 'FWD', sub: 'ST', label: 'ST', x: 0.6, y: 0.5 },
    { role: 'FWD', sub: 'W', label: 'RW', x: 0.58, y: 0.88 },
  ],
  '4-2-3-1': [
    GK_SLOT,
    ...BACK_FOUR,
    { role: 'MID', sub: 'DM', label: 'DM', x: 0.32, y: 0.36 },
    { role: 'MID', sub: 'DM', label: 'DM', x: 0.32, y: 0.64 },
    { role: 'MID', sub: 'W', label: 'LW', x: 0.5, y: 0.14 },
    { role: 'MID', sub: 'AM', label: 'AM', x: 0.48, y: 0.5 },
    { role: 'MID', sub: 'W', label: 'RW', x: 0.5, y: 0.86 },
    LONE_STRIKER,
  ],
  '4-1-4-1': [
    GK_SLOT,
    ...BACK_FOUR,
    { role: 'MID', sub: 'DM', label: 'DM', x: 0.3, y: 0.5 },
    { role: 'MID', sub: 'WM', label: 'LM', x: 0.42, y: 0.12 },
    { role: 'MID', sub: 'CM', label: 'CM', x: 0.42, y: 0.36 },
    { role: 'MID', sub: 'CM', label: 'CM', x: 0.42, y: 0.64 },
    { role: 'MID', sub: 'WM', label: 'RM', x: 0.42, y: 0.88 },
    LONE_STRIKER,
  ],
  '4-4-1-1': [GK_SLOT, ...BACK_FOUR, ...MID_FOUR, { role: 'FWD', sub: 'AM', label: 'SS', x: 0.5, y: 0.5 }, LONE_STRIKER],
  '3-5-2': [GK_SLOT, ...BACK_THREE, ...wingBacks(0.32), ...MID_THREE(0.32, 0.42), ...TWO_STRIKERS],
  '3-4-3': [
    GK_SLOT,
    ...BACK_THREE,
    ...wingBacks(0.34),
    { role: 'MID', sub: 'DM', label: 'CM', x: 0.36, y: 0.4 },
    { role: 'MID', sub: 'CM', label: 'CM', x: 0.4, y: 0.6 },
    { role: 'FWD', sub: 'W', label: 'LW', x: 0.58, y: 0.15 },
    LONE_STRIKER,
    { role: 'FWD', sub: 'W', label: 'RW', x: 0.58, y: 0.85 },
  ],
  '5-3-2': [GK_SLOT, ...BACK_THREE, ...wingBacks(0.22), ...MID_THREE(0.34, 0.38, 0.3), ...TWO_STRIKERS],
  '5-4-1': [GK_SLOT, ...BACK_THREE, ...wingBacks(0.22), ...MID_FOUR, LONE_STRIKER],
};

export const FORMATION_IDS = Object.keys(FORMATIONS) as FormationId[];
export const DEFAULT_FORMATION: FormationId = '4-4-2';

/** The default formation's slots. Kept for callers that predate formations. */
export const FORMATION: FormationSlot[] = FORMATIONS[DEFAULT_FORMATION];

export const formationOf = (id: FormationId | undefined): FormationSlot[] => FORMATIONS[id ?? DEFAULT_FORMATION] ?? FORMATION;
export const isFormationId = (v: unknown): v is FormationId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(FORMATIONS, v);

/**
 * How aggressively a side plays, from a deep low block to pressing high. The
 * CPU's knobs for each step are TACTICS in src/sim/ai.ts: line height,
 * compactness, who presses and when, counter-pressing, how many commit
 * forward, pass risk and tempo, how far the full-backs go.
 */
export type Mentality = 'park' | 'defensive' | 'balanced' | 'attacking' | 'press';
/** Deepest to most aggressive, the order the tactics board shows. (Replays store a mentality by its own code, MENTALITY_CODES in src/meta/replay.ts.) */
export const MENTALITY_IDS: Mentality[] = ['park', 'defensive', 'balanced', 'attacking', 'press'];
export const DEFAULT_MENTALITY: Mentality = 'balanced';
export const MENTALITY_LABEL: Record<Mentality, string> = {
  park: 'Park the bus',
  defensive: 'Defensive',
  balanced: 'Balanced',
  attacking: 'Attacking',
  press: 'High press',
};
export const isMentality = (v: unknown): v is Mentality => typeof v === 'string' && (MENTALITY_IDS as string[]).includes(v);
/** A team's mentality, Balanced when it has none. */
export const mentalityOf = (m: Mentality | undefined): Mentality => (isMentality(m) ? m : DEFAULT_MENTALITY);
/**
 * Rolling ball. Below ROLL_FAST_V it slows at ROLL_A + ROLL_B * v m/s per
 * second (a short pass feels the same as it always did); above, the speed
 * term is only ROLL_FAST_B, so a struck shot or a long pass keeps its pace
 * across a full-size pitch. Continuous at ROLL_FAST_V. rollDistance and
 * rollTravel in kicks.ts integrate it exactly.
 */
export const ROLL_A = 1.6;
export const ROLL_B = 0.35;
export const ROLL_FAST_V = 6;
export const ROLL_FAST_B = 0.08;
/** Deceleration of a rolling ball at speed v, m/s per second. */
export const rollDecel = (v: number): number => ROLL_A + ROLL_B * Math.min(v, ROLL_FAST_V) + ROLL_FAST_B * Math.max(0, v - ROLL_FAST_V);

/** Horizontal drag on a ball in the air, per second (much weaker than floor friction). */
export const AIR_DRAG = 0.12;

/** Standing tackle reach (m). A human's right click stands within this of the man and slides beyond it. */
export const STAND_REACH = 2;
/** How far a slide tackle goes at most (m). */
export const SLIDE_TRAVEL = 4;
