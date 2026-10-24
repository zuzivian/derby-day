import type { Role } from './constants.ts';
import type { Rng } from './rng.ts';
import type { Vec } from './vec.ts';

/** Attributes as the sim sees them, 0..1. The club layer stores 1..99. */
export interface SimAttrs {
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  stamina: number;
  goalkeeping: number;
}

export interface PlayerSetup {
  id: string;
  name: string;
  number: number;
  role: Role;
  attrs: SimAttrs;
}

export interface TeamSetup {
  name: string;
  short: string;
  primary: string;
  secondary: string;
  /** Exactly TEAM_SIZE players, in FORMATION slot order. */
  players: PlayerSetup[];
  /** 0..1. Drives how quickly and how well the CPU decides. */
  aiSkill: number;
}

export interface MatchPlayer {
  i: number;
  team: 0 | 1;
  slot: number;
  role: Role;
  id: string;
  name: string;
  number: number;
  attrs: SimAttrs;
  pos: Vec;
  vel: Vec;
  facing: Vec;
  energy: number;
  /** True on ticks where the player is actually sprinting (asked to, and has the legs for it). */
  sprinting: boolean;
  /** Out of breath: sprint is locked until energy recovers. */
  winded: boolean;
  stun: number;
  tackleCd: number;
  kickCd: number;
  aiTimer: number;
  jitter: Vec;
  jitterTimer: number;
  holdTicks: number;
  /** Scratch memory for the CPU brain in ai.ts. Created lazily there; nothing else reads it. */
  ai?: AiMemory;
}

export interface AiMemory {
  /** Tick of the last aiIntent call, to notice kickoffs and long gaps. */
  lastTick: number;
  /** Cached off-ball target and ticks until it is re-evaluated. */
  target: Vec | null;
  retarget: number;
  /** Whether the team was attacking when the target was chosen. */
  attacking: boolean;
  /** Carrier behaviour that persists across ticks. */
  mode: 'none' | 'takeon' | 'shield';
  modeTicks: number;
  modeTarget: Vec | null;
}

export interface Ball {
  pos: Vec;
  vel: Vec;
  owner: number;
  lastTouch: number;
  /** Intended receiver of the pass in flight, or -1. */
  receiver: number;
  passFrom: number;
  noPickup: number[];
  /** Height above the floor in metres. 0 while rolling or held. Never negative. */
  z: number;
  /** Vertical velocity, m/s. */
  vz: number;
  /** Ticks left of the first-touch cushion after a player takes the ball. */
  touch: number;
}

export type Phase = 'kickoff' | 'play' | 'goal' | 'halftime' | 'fulltime';

export interface MatchEvent {
  tick: number;
  minute: number;
  team: 0 | 1;
  scorer: string;
}

export interface TeamStats {
  shots: number;
  onTarget: number;
  passes: number;
  tackles: number;
  possessionTicks: number;
}

export interface MatchState {
  tick: number;
  rng: Rng;
  teams: [TeamSetup, TeamSetup];
  players: MatchPlayer[];
  ball: Ball;
  score: [number, number];
  phase: Phase;
  phaseTicks: number;
  half: 1 | 2;
  /** Ticks of live play elapsed. */
  clock: number;
  halfTicks: number;
  kickoffTeam: 0 | 1;
  /** Per team: is a human steering one of its players? [false, false] is CPU vs CPU. */
  humans: [boolean, boolean];
  /** Per team: index of the player that team's human steers, or -1 for a CPU team. */
  controlled: [number, number];
  /** Per team: ticks until the auto-switch next re-checks who the human should steer. */
  switchTimer: [number, number];
  events: MatchEvent[];
  stats: [TeamStats, TeamStats];
  /** CPU team plans, owned by ai.ts. Kept in the state (not a module cache) so a cloned state replays identically. */
  aiPlans?: [AiTeamPlan | null, AiTeamPlan | null];
}

export interface AiInterception {
  t: number;
  pt: Vec;
}

export interface AiTeamPlan {
  /** Tick the plan was built on. Weaker teams rebuild less often: that is their reaction delay. */
  tick: number;
  /** True when this team has the ball or is clearly about to. */
  attacking: boolean;
  /** AI player who goes to the ball or presses the carrier; -1 if none (e.g. the human is nearest). */
  chaser: number;
  /** Where the ball is, as this team perceives it. */
  focus: Vec;
  /** Per player index: interception of a loose ball, or null when someone holds it. */
  icpt: (AiInterception | null)[];
  bestUs: number;
  bestThem: number;
  /** Per player index: opponent index to mark, or -1. */
  mark: number[];
  /** Player who sweeps between ball and goal when defending, or -1. */
  cover: number;
}


/**
 * One tick of input from a human. Small and serialisable on purpose: this is
 * what a client would send to an authoritative server (or to the other peer
 * in lockstep, see src/net/lockstep.ts).
 *
 * Two schemes share the one shape; the sim tells them apart by `cursor`.
 *
 * Pointer scheme (`cursor` present: mouse and touch). The player runs toward
 * the pointer and how far away the pointer is sets the speed (see
 * src/sim/human.ts: a walk close in, a full sprint far out). The pointer is
 * also the aim of every kick:
 *   with the ball      `pass`    ground pass that rolls to the pointer
 *                      `loft`    lofted ball that lands at the pointer
 *                      `shoot`   shot toward the pointer
 *   without the ball   `select`  switch to the teammate under the pointer,
 *                                else the nearest one in its direction
 *                      `tackle`  standing tackle, or a slide if the pointer is far
 *
 * Key scheme (`dir` present). The player runs along `dir` at full pace
 * (`sprint` for +18%) and kicks go where they are heading. `tackle` goes for
 * the ball and `switchPlayer` cycles to the player nearest it.
 *
 * Kick and switch fields are one-shot: set only on the tick the player acts.
 */
export interface HumanInput {
  /** Pointer scheme: world-space point the controlled player runs toward and aims at. */
  cursor?: Vec;
  /** Key scheme: movement axes, each -1..1. */
  dir?: Vec;
  /** With the ball: ground pass (to the pointer; with keys, to the teammate in front). */
  pass?: boolean;
  /** With the ball: lofted ball (high pass, cross, lob). 0..1 is how long the button was held: more height and range. */
  loft?: number;
  /** With the ball: shoot with this power, 0..1. */
  shoot?: number;
  /** Without the ball: tackle toward the pointer (a slide when it is far), or for the ball with keys. */
  tackle?: boolean;
  /** Pointer scheme, without the ball: switch to the player under the pointer, else the nearest one in that direction. */
  select?: boolean;
  /** Key scheme only: sprint while held, +18% top speed, drains energy. The pointer sprints by distance instead. */
  sprint?: boolean;
  /** Key scheme: switch to the player nearest the ball. */
  switchPlayer?: boolean;
}

/** Input for both teams in one tick: index 0 is the home side, 1 the away side. */
export type TeamInputs = [HumanInput, HumanInput];

/**
 * What a player does with the ball at their feet (or, for a tackle, near it).
 * Restarts (throw-ins, corners, free kicks) take these too: whoever takes the
 * kick sends the same pass, loft or shoot.
 */
export type Action =
  /**
   * Ground pass. `speed` (m/s) is the kick speed when given, otherwise the CPU's
   * usual pass speed for the distance. A human pass to a point sets it so the
   * ball rolls out at the target (see groundPassPlan in kicks.ts). `receiver`
   * is the teammate it is meant for, -1 for a pass into space; `through` plays
   * it a touch firmer.
   */
  | { kind: 'pass'; target: Vec; receiver: number; through?: boolean; speed?: number }
  | { kind: 'shoot'; target: Vec; power: number }
  /** CPU chip: lofted, lands near `target` or as far as `power` allows. `chipPlan()` previews it. */
  | { kind: 'chip'; target: Vec; power: number }
  /**
   * Human lofted ball: lands on `target`, up to the range `power` allows, and
   * `power` (0..1) also sets how high it flies. `loftPlan()` previews it.
   */
  | { kind: 'loft'; target: Vec; power: number }
  /** `slide`: a committed lunge that reaches further but leaves the tackler on the floor for a moment. */
  | { kind: 'tackle'; target: Vec; slide?: boolean };

export interface Intent {
  move: Vec;
  throttle: number;
  /** Ask to sprint this tick. Ignored when winded. */
  sprint?: boolean;
  action?: Action;
}
