// Instant replays, the pure half: spotting the moments worth a replay as the
// match runs, and a small ring buffer that can re-create the last few seconds
// exactly. matchView.ts decides when to show one and drives the renderer.
//
// What counts (owner ask 10, research brief §6): goals, cards, saves from
// shots on target, shots off the woodwork, and near misses (wide within
// HIGHLIGHT_MISS_M of a post, or just over the bar).
//
// The buffer keeps a deep copy of the match state every SNAP_EVERY ticks and
// the input each tick was stepped with. The sim is deterministic and its state
// is plain data, so cloning a snapshot and stepping it with the same inputs
// replays those ticks exactly, without touching the live match.

import { GOAL_BAR_H, GOAL_BOTTOM, GOAL_TOP, PITCH_W, TICK_HZ } from '../sim/constants.ts';
import { step } from '../sim/match.ts';
import type { HumanInput, MatchState, TeamInputs } from '../sim/types.ts';

export type HighlightKind = 'goal' | 'red' | 'yellow' | 'save' | 'woodwork' | 'miss';

export interface Highlight {
  kind: HighlightKind;
  /** The tick the moment happened (the ball crossing the line, the save, the foul behind a card). */
  tick: number;
  /** Sim x of the goal line the moment happened at (the end the attack went to), for the replay cameras. */
  goalX: number;
  /** Line under REPLAY, e.g. "Goal · R. Smith 34'". */
  label: string;
}

/** Higher is more worth a replay; a better moment replaces a pending one. */
export const HIGHLIGHT_RANK: Record<HighlightKind, number> = { goal: 6, red: 5, save: 4, woodwork: 4, yellow: 2, miss: 3 };
/** Wide of the post by at most this, or over the bar by at most half this, is a near miss. */
export const HIGHLIGHT_MISS_M = 1.5;
/** Saves count from shots struck at least this hard, m/s (a tame roll into the keeper's arms is not a moment). */
export const HIGHLIGHT_SAVE_SPEED = 17;
/** A shot is followed for this long for a save, the woodwork or a near miss. */
const SHOT_WATCH = Math.round(2.5 * TICK_HZ);

interface ShotWatch {
  team: 0 | 1;
  tick: number;
  onTarget: boolean;
  goalX: number;
  shooter: string;
  speed: number;
}

/** Watches the live match tick by tick and reports highlights. Reads state only. */
export class HighlightSpotter {
  private goals = 0;
  private events = 0;
  private shots: [number, number] = [0, 0];
  private onTarget: [number, number] = [0, 0];
  private watch: ShotWatch | null = null;
  private prev = { x: 0, y: 0, vx: 0, vy: 0, z: 0, vz: 0, owner: -1 };

  constructor(s: MatchState) {
    this.goals = s.goals.length;
    this.events = s.events.length;
    this.shots = [s.stats[0].shots, s.stats[1].shots];
    this.onTarget = [s.stats[0].onTarget, s.stats[1].onTarget];
    this.remember(s);
  }

  private remember(s: MatchState) {
    const b = s.ball;
    this.prev = { x: b.pos.x, y: b.pos.y, vx: b.vel.x, vy: b.vel.y, z: b.z, vz: b.vz, owner: b.owner };
  }

  /** Call once after every sim step. Returns what happened this tick (usually nothing). */
  update(s: MatchState): Highlight[] {
    const out: Highlight[] = [];
    const name = (i: number) => (i >= 0 && s.players[i] ? s.players[i].name : '');
    // Goals.
    while (this.goals < s.goals.length) {
      const g = s.goals[this.goals++];
      out.push({ kind: 'goal', tick: s.tick, goalX: g.team === 0 ? PITCH_W : 0, label: `Goal · ${g.scorer} ${g.minute}'` });
      this.watch = null;
    }
    // Cards: replay the challenge behind it (the last foul by that player), not the referee.
    for (; this.events < s.events.length; this.events++) {
      const e = s.events[this.events];
      if (e.kind !== 'card') continue;
      let at = e.tick;
      for (let i = this.events - 1; i >= 0 && i >= this.events - 12; i--) {
        const f = s.events[i];
        if (f.kind === 'foul' && f.player === e.player) {
          at = f.tick;
          break;
        }
      }
      // The goal the fouled side was attacking: the offender's own.
      const goalX = e.team === 0 ? 0 : PITCH_W;
      out.push({ kind: e.color === 'red' ? 'red' : 'yellow', tick: at, goalX, label: `${e.color === 'red' ? 'Red card' : 'Yellow card'} · ${e.name}` });
    }
    // Shots: start watching when the sim counts one.
    for (const t of [0, 1] as const) {
      const st = s.stats[t];
      if (st.shots > this.shots[t]) {
        const owner = this.prev.owner;
        this.watch = { team: t, tick: s.tick, onTarget: st.onTarget > this.onTarget[t], goalX: t === 0 ? PITCH_W : 0, shooter: name(owner), speed: Math.hypot(s.ball.vel.x, s.ball.vel.y) };
      }
      this.shots[t] = st.shots;
      this.onTarget[t] = st.onTarget;
    }
    const w = this.watch;
    if (w && s.goals.length === this.goals) {
      const hit = this.shotOutcome(s, w);
      if (hit) {
        out.push(hit);
        this.watch = null;
      } else if (s.tick - w.tick > SHOT_WATCH) this.watch = null;
    }
    this.remember(s);
    return out;
  }

  private shotOutcome(s: MatchState, w: ShotWatch): Highlight | null {
    const b = s.ball;
    const p = this.prev;
    const who = w.shooter ? ` · ${w.shooter}` : '';
    const def = w.team === 0 ? 1 : 0;
    // Back with the shooting side (a rebound tapped in is its own goal): stop watching.
    if (b.owner >= 0 && s.players[b.owner].team === w.team && s.tick - w.tick > 6) {
      this.watch = null;
      return null;
    }
    // Saves: the defending keeper catches it, or the ball turns sharply right by him.
    const keeper = s.players.find((q) => q.team === def && q.role === 'GK' && !q.sentOff);
    if (w.onTarget && keeper && w.speed >= HIGHLIGHT_SAVE_SPEED) {
      const caught = b.owner === keeper.i && p.owner !== keeper.i;
      const dKeeper = Math.hypot(b.pos.x - keeper.pos.x, b.pos.y - keeper.pos.y);
      const sp0 = Math.hypot(p.vx, p.vy);
      const sp1 = Math.hypot(b.vel.x, b.vel.y);
      const turned = sp0 > 6 && (p.vx * b.vel.x + p.vy * b.vel.y) / (sp0 * Math.max(0.01, sp1)) < 0.5;
      if (caught || (b.owner < 0 && dKeeper < 2.6 && turned)) return { kind: 'save', tick: s.tick, goalX: w.goalX, label: `Save · ${keeper.name}` };
    }
    // The woodwork: the ball turns round at a post or the bar.
    const nearLine = Math.abs(b.pos.x - w.goalX) < 0.9;
    if (nearLine) {
      const atPost = Math.min(Math.abs(b.pos.y - GOAL_TOP), Math.abs(b.pos.y - GOAL_BOTTOM)) < 0.5 && b.z < GOAL_BAR_H + 0.2;
      const atBar = b.pos.y > GOAL_TOP - 0.2 && b.pos.y < GOAL_BOTTOM + 0.2 && Math.abs(b.z - GOAL_BAR_H) < 0.4;
      const sp0 = Math.hypot(p.vx, p.vy);
      const sp1 = Math.hypot(b.vel.x, b.vel.y);
      const turned = sp0 > 4 && (p.vx * b.vel.x + p.vy * b.vel.y) / (sp0 * Math.max(0.01, sp1)) < 0.7;
      const bounced = atBar && Math.abs(p.vz) > 1 && Math.sign(p.vz) !== Math.sign(b.vz);
      if ((atPost && turned) || (atBar && (turned || bounced))) return { kind: 'woodwork', tick: s.tick, goalX: w.goalX, label: `Off the woodwork${who}` };
    }
    // A near miss: out over the goal line just wide, or just over.
    const crossed = (w.goalX === 0 && b.pos.x < 0 && p.x >= 0) || (w.goalX === PITCH_W && b.pos.x > PITCH_W && p.x <= PITCH_W);
    if (crossed) {
      const wide = b.pos.y < GOAL_TOP ? GOAL_TOP - b.pos.y : b.pos.y > GOAL_BOTTOM ? b.pos.y - GOAL_BOTTOM : 0;
      const over = b.z - GOAL_BAR_H;
      if ((wide > 0 && wide < HIGHLIGHT_MISS_M && b.z < GOAL_BAR_H + 1) || (wide === 0 && over > 0 && over < HIGHLIGHT_MISS_M / 2)) {
        return { kind: 'miss', tick: s.tick, goalX: w.goalX, label: `So close${who}` };
      }
      this.watch = null;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// The buffer

/** A snapshot every half second; replays start from the one at or before their first tick. */
export const SNAP_EVERY = 30;
/** How far back the buffer reaches, ticks (12 s: research brief §6). */
export const BUFFER_TICKS = 12 * TICK_HZ;

export type TickInput = HumanInput | TeamInputs | undefined;

/** Deep copy of a match state. The state is plain data (the rng is { s }), so structuredClone is exact. */
export function cloneState(s: MatchState): MatchState {
  return structuredClone(s);
}

export class ReplayBuffer {
  private snaps: MatchState[] = [];
  /** inputs[i] is what tick (base + i + 1) was stepped with. */
  private inputs: TickInput[] = [];
  private base = 0;

  constructor(s: MatchState) {
    this.reset(s);
  }

  /** Forget everything and start from this state (for a match that started, or one that jumped). */
  reset(s: MatchState): void {
    this.snaps = [cloneState(s)];
    this.inputs = [];
    this.base = s.tick;
  }

  /** Call after every live step, with the input that step used and the state after it. */
  push(input: TickInput, s: MatchState): void {
    if (s.tick !== this.base + this.inputs.length + 1) {
      this.reset(s);
      return;
    }
    this.inputs.push(input);
    if (s.tick % SNAP_EVERY === 0) this.snaps.push(cloneState(s));
    // Drop what is older than BUFFER_TICKS, keeping a snapshot at or before the window's start.
    while (this.snaps.length > 1 && this.snaps[1].tick <= s.tick - BUFFER_TICKS) {
      const drop = this.snaps[1].tick - this.snaps[0].tick;
      this.snaps.shift();
      this.inputs.splice(0, drop);
      this.base = this.snaps[0].tick;
    }
  }

  /** The oldest tick a replay can start at. */
  get earliest(): number {
    return this.snaps[0].tick;
  }

  /** The newest tick in the buffer. */
  get latest(): number {
    return this.base + this.inputs.length;
  }

  /**
   * A fresh state at `tick` (clamped to what the buffer holds), and a stepper that moves it on one
   * tick at a time with the recorded inputs, up to `latest`. The live match is never touched.
   */
  open(tick: number): { state: MatchState; step: () => boolean } {
    const t = Math.max(this.earliest, Math.min(this.latest, tick));
    let snap = this.snaps[0];
    for (const sn of this.snaps) if (sn.tick <= t) snap = sn;
    const state = cloneState(snap);
    const advance = (): boolean => {
      if (state.tick >= this.latest) return false;
      step(state, this.inputs[state.tick - this.base]);
      return true;
    };
    while (state.tick < t) advance();
    return { state, step: advance };
  }
}
