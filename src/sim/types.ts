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
  /** Team the local human controls, or -1 for CPU vs CPU. */
  humanTeam: 0 | 1 | -1;
  controlled: number;
  switchTimer: number;
  events: MatchEvent[];
  stats: [TeamStats, TeamStats];
}

/**
 * One tick of input from a human. Small and serialisable on purpose: this is
 * what a client would send to an authoritative server.
 */
export interface HumanInput {
  /** Mouse mode: world-space point the controlled player runs toward and aims at. */
  cursor?: Vec;
  /** Keyboard mode: movement axes, each -1..1. */
  dir?: Vec;
  /** With the ball: pass. Without: tackle. */
  pass?: boolean;
  /** With the ball: shoot with this power, 0..1. */
  shoot?: number;
  /** Sprint while held: +18% top speed, drains energy. */
  sprint?: boolean;
  /** With `pass`: play the ball into space ahead of the receiver instead of to feet. */
  through?: boolean;
  /** With `shoot`: chip it (lofted, lands near the target, range set by power). */
  chip?: boolean;
  switchPlayer?: boolean;
}

export type Action =
  /** `through`: `target` is already led ahead of the receiver; the ball is played a touch firmer. */
  | { kind: 'pass'; target: Vec; receiver: number; through?: boolean }
  | { kind: 'shoot'; target: Vec; power: number }
  /** Lofted ball that lands near `target` (or as far as `power` allows). Pass `chipPlan()` to preview. */
  | { kind: 'chip'; target: Vec; power: number }
  | { kind: 'tackle'; target: Vec };

export interface Intent {
  move: Vec;
  throttle: number;
  /** Ask to sprint this tick. Ignored when winded. */
  sprint?: boolean;
  action?: Action;
}
