import type { FormationId, Role, SubRole } from './constants.ts';
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
  /** Exactly TEAM_SIZE players, in the formation's slot order (FORMATIONS in constants.ts). */
  players: PlayerSetup[];
  /** 0..1. Drives how quickly and how well the CPU decides. */
  aiSkill: number;
  /** Default '4-4-2'. */
  formation?: FormationId;
}

export interface MatchPlayer {
  i: number;
  team: 0 | 1;
  slot: number;
  /** The slot's role. A keeper sent off is replaced in goal by an outfielder, whose role becomes 'GK'. */
  role: Role;
  /** Finer position from the formation slot (full-back, holding midfielder, winger...). */
  sub: SubRole;
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
  /** Yellow cards this match (0, 1; a second one is a red). */
  yellow: number;
  /** Shown a red card: off the pitch for the rest of the match. Its position is parked far outside the pitch. */
  sentOff: boolean;
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
  mode: 'none' | 'takeon' | 'shield' | 'dive';
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
  /** The restart the ball was last played from, until another player touches it (throw-ins can't score directly, etc). */
  setPiece: RestartKind | null;
  /** With setPiece: false for an indirect free kick or a throw-in (a goal needs another touch first). */
  setPieceDirect: boolean;
  /** Last player to kick the ball on purpose (pass, shot, clearance), or -1. A keeper may not handle a teammate's kick. */
  kickedBy: number;
  /** A keeper is holding it, or a thrower has it above the head. */
  inHands: boolean;
}

/** 'restart' is a dead ball between an out-of-play/foul/offside and the restart being taken. */
export type Phase = 'kickoff' | 'play' | 'restart' | 'goal' | 'halftime' | 'fulltime';

export type RestartKind = 'kickoff' | 'throwin' | 'goalkick' | 'corner' | 'freekick' | 'penalty';

/**
 * A restart in progress (Laws 8, 13-17). The stages:
 *   whistle  the ball is dead and still rolling; players ease off.
 *   setup    the ball is on the spot, the taker walks to it, everyone takes up legal positions.
 *   ready    the taker is over the ball (or holding it for a throw-in) and plays it when ready.
 * Kick-offs only use 'ready' (during Phase 'kickoff').
 */
export interface Restart {
  kind: RestartKind;
  /** Team taking it. */
  team: 0 | 1;
  /** Where the ball is placed. */
  spot: Vec;
  /** Player index of the taker, or -1 until chosen at the start of setup. */
  taker: number;
  stage: 'whistle' | 'setup' | 'ready';
  /** Ticks spent in the current stage. */
  ticks: number;
  /** Can a goal be scored straight from it? False for an indirect free kick and a throw-in. */
  direct: boolean;
  /** Why play stopped. */
  reason: 'out' | 'foul' | 'offside' | 'goal' | 'half' | 'start';
  /** CPU taker: ticks to wait in 'ready' before playing it. */
  wait: number;
}

export interface Referee {
  pos: Vec;
  vel: Vec;
  facing: Vec;
}

export type FoulSeverity = 'careless' | 'reckless' | 'excessive';
export type CardReason = 'reckless' | 'excessive' | 'spa' | 'dogso' | 'second-yellow';

interface EventBase {
  tick: number;
  /** 1..90 on the match clock. */
  minute: number;
  /** Match clock in seconds, 0..5400 (matchSeconds). */
  second: number;
  team: 0 | 1;
  /** Player index the event is about, or -1. */
  player: number;
}

export interface GoalEvent extends EventBase {
  kind: 'goal';
  /** Scoring team. */
  team: 0 | 1;
  scorer: string;
  ownGoal: boolean;
  /** Restart the goal came from directly (one touch), or 'play'. */
  from: RestartKind | 'play';
}
export interface FoulEvent extends EventBase {
  kind: 'foul';
  /** Offending team; player is the offender. */
  victim: number;
  spot: Vec;
  severity: FoulSeverity;
  penalty: boolean;
  /** The referee waved play on (advantage). */
  advantage: boolean;
}
export interface CardEvent extends EventBase {
  kind: 'card';
  color: 'yellow' | 'red';
  name: string;
  /** A second yellow: always followed by the red it brings (which has this set too). */
  secondYellow: boolean;
  reason: CardReason;
}
export interface OffsideEvent extends EventBase {
  kind: 'offside';
  /** Offending (attacking) team; the assistant's flag goes up. */
  spot: Vec;
}
export interface RestartEvent extends EventBase {
  kind: 'restart';
  /** Team awarded it; player is the taker once known (-1 when awarded). */
  restart: RestartKind;
  spot: Vec;
  direct: boolean;
  reason: Restart['reason'];
}
export interface RestartTakenEvent extends EventBase {
  kind: 'restartTaken';
  restart: RestartKind;
  spot: Vec;
}
export interface AdvantageEvent extends EventBase {
  kind: 'advantage';
  /** Team benefiting. */
  spot: Vec;
}
export interface PhaseEvent extends EventBase {
  kind: 'halftime' | 'fulltime';
}
export interface SendOffEvent extends EventBase {
  kind: 'sentOff';
  name: string;
}

/** Everything a renderer, commentary or audio might key off, in tick order. */
export type MatchEvent = GoalEvent | FoulEvent | CardEvent | OffsideEvent | RestartEvent | RestartTakenEvent | AdvantageEvent | PhaseEvent | SendOffEvent;

export interface TeamStats {
  shots: number;
  onTarget: number;
  passes: number;
  tackles: number;
  possessionTicks: number;
  fouls: number;
  yellows: number;
  reds: number;
  corners: number;
  offsides: number;
  throwIns: number;
  goalKicks: number;
  freeKicks: number;
  penalties: number;
}

/** A pass by `team` with these players in an offside position when it was played (Law 11). */
export interface OffsideWatch {
  team: 0 | 1;
  tick: number;
  players: number[];
}

/** Advantage being played: if `team` loses the ball before `until`, the free kick comes back. */
export interface Advantage {
  team: 0 | 1;
  until: number;
  spot: Vec;
  penalty: boolean;
}

export interface PendingCard {
  player: number;
  color: 'yellow' | 'red';
  reason: CardReason;
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
  /** Goals only, in order (also in `events`). */
  goals: GoalEvent[];
  /** Every goal, foul, card, offside, restart and half/full-time whistle, in order. */
  events: MatchEvent[];
  /** Cards shown, in order (also in `events`). */
  cards: CardEvent[];
  stats: [TeamStats, TeamStats];
  /** The restart in progress during Phase 'restart' and 'kickoff', else null. */
  restart: Restart | null;
  referee: Referee;
  offside: OffsideWatch | null;
  advantage: Advantage | null;
  /** Cards decided during an advantage, shown at the next stoppage. */
  pendingCards: PendingCard[];
  /** CPU team plans, owned by ai.ts. Kept in the state (not a module cache) so a cloned state replays identically. */
  aiPlans?: [AiTeamPlan | null, AiTeamPlan | null];
  /** CPU set-piece positions for the restart in progress, owned by ai.ts (refreshed every 15 ticks). */
  aiRestart?: { key: number; kind: RestartKind; team: 0 | 1; targets: (Vec | null)[] };
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
  /** Height of this team's back line in team coordinates (0 own goal line .. 1 the opponent's). */
  line: number;
  /** The opponents' back line (second-last opponent) in this team's coordinates: attackers stay level with it until the pass. */
  oppLine: number;
  /** Tick this spell of possession began (attacking), for urgency: a side that has kept it a while takes more risks. */
  possSince: number;
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
  /** `lift`: optional initial vertical speed in m/s (a dipping free kick over the wall). Added for the CPU; humans leave it out. */
  | { kind: 'shoot'; target: Vec; power: number; lift?: number }
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
