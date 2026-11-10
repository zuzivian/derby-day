// Synthesised sound for matches. Nothing is downloaded: every sound is built
// from oscillators and filtered noise with the Web Audio API at runtime.
//
// Two halves:
//   detectSfx()   pure. Diffs a tiny Snapshot against the next MatchState and
//                 returns what a spectator would hear. Unit-tested.
//   SoundEngine   browser only. Starts lazily after a user gesture, owns the
//                 master gain, mute setting and the crowd bed.

import { GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W, STAND_CD } from '../sim/constants.ts';
import { matchSeconds } from '../sim/rules.ts';
import type { MatchState, Phase } from '../sim/types.ts';

// ---------------------------------------------------------------------------
// Event detection (pure)

export interface Snapshot {
  phase: Phase | 'init';
  goals: number;
  tackles: number;
  /** Players currently in the first ticks of a tackle lunge. */
  lunges: number;
  owner: number;
  bx: number;
  by: number;
  vx: number;
  vy: number;
  /** Ball height, m. */
  bz: number;
  /** Match events so far (fouls, cards, restarts...). */
  events: number;
}

export type SfxEvent =
  | { type: 'kick'; kind: 'pass' | 'shot'; power: number }
  | { type: 'knock'; kind: 'board' | 'post'; power: number }
  | { type: 'tackle'; won: boolean }
  | { type: 'goal'; team: 0 | 1 }
  | { type: 'whistle'; kind: WhistleKind }
  /** The crowd's "ooh": a shot just wide or over, or a hard shot saved. */
  | { type: 'ooh'; power: number }
  /** A keeper gathering the ball into his hands. */
  | { type: 'catch'; power: number }
  | { type: 'header'; power: number }
  /** The referee's big calls: a card shown, the assistant's flag for offside, a penalty awarded. */
  | { type: 'call'; kind: CallKind };

export type CallKind = 'yellow' | 'red' | 'offside' | 'penalty';

/** 'foul': one short blast when the referee stops play for a foul, an offside, an advantage brought back or a second touch. */
export type WhistleKind = 'kickoff' | 'halftime' | 'fulltime' | 'foul';

/** A tackle sets tackleCd to at least STAND_CD on the tick it starts (more for a miss or a slide). */
const LUNGE_CD = STAND_CD;
const SPEED_NOISE = 2.5;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const speedOf = (vx: number, vy: number) => Math.hypot(vx, vy);

export function snapshot(s: MatchState): Snapshot {
  return {
    phase: s.phase,
    goals: s.goals.length,
    tackles: s.stats[0].tackles + s.stats[1].tackles,
    lunges: snapshotLunges(s),
    owner: s.ball.owner,
    bx: s.ball.pos.x,
    by: s.ball.pos.y,
    vx: s.ball.vel.x,
    vy: s.ball.vel.y,
    bz: s.ball.z,
    events: s.events.length,
  };
}

/** Play has just stopped: was it the referee's whistle (not the ball going out of play)? */
function stoppedForFoul(s: MatchState): boolean {
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i];
    if (e.kind === 'restart') return e.reason !== 'out' && e.restart !== 'kickoff';
  }
  return false;
}

/** A snapshot to start from so the opening kick-off whistles. */
export function initialSnapshot(s: MatchState): Snapshot {
  return { ...snapshot(s), phase: 'init' };
}

const POSTS = [
  { x: 0, y: GOAL_TOP },
  { x: 0, y: GOAL_BOTTOM },
  { x: PITCH_W, y: GOAL_TOP },
  { x: PITCH_W, y: GOAL_BOTTOM },
];

/**
 * What changed between `prev` and `next` that makes a noise. Designed to be
 * called after every sim step; it still behaves sensibly if frames are skipped.
 */
export function detectSfx(prev: Snapshot, next: MatchState): SfxEvent[] {
  const out: SfxEvent[] = [];
  const b = next.ball;

  // Phase changes: whistles, goals.
  if (next.goals.length > prev.goals) out.push({ type: 'goal', team: next.goals[next.goals.length - 1].team });
  if (next.phase !== prev.phase) {
    if (next.phase === 'kickoff') out.push({ type: 'whistle', kind: 'kickoff' });
    else if (next.phase === 'halftime') out.push({ type: 'whistle', kind: 'halftime' });
    else if (next.phase === 'fulltime') out.push({ type: 'whistle', kind: 'fulltime' });
    else if (next.phase === 'restart' && prev.phase === 'play' && stoppedForFoul(next)) out.push({ type: 'whistle', kind: 'foul' });
  }
  const prevSpeed = speedOf(prev.vx, prev.vy);
  // A shot that has just gone out for a goal kick or corner close to the posts gets an "ooh". (The
  // referee's whistle for a stoppage is the phase change above.)
  for (let i = prev.events; i < next.events.length; i++) {
    const e = next.events[i];
    if (e.kind === 'card' && !(e.color === 'yellow' && e.secondYellow)) out.push({ type: 'call', kind: e.color });
    else if (e.kind === 'offside') out.push({ type: 'call', kind: 'offside' });
    else if ((e.kind === 'foul' && e.penalty && !e.advantage) || (e.kind === 'restart' && e.restart === 'penalty' && e.reason === 'advantage')) out.push({ type: 'call', kind: 'penalty' });
    if (e.kind === 'restart' && e.reason === 'out' && (e.restart === 'goalkick' || e.restart === 'corner') && nearMiss(prev, prevSpeed)) out.push({ type: 'ooh', power: clamp01((prevSpeed - 10) / 16) });
  }
  if (prev.phase !== 'play' && prev.phase !== 'init') return out;

  const speed = speedOf(b.vel.x, b.vel.y);

  // A keeper gathering the ball: a catch, and from a hard shot the crowd's "ooh" too.
  if (prev.owner < 0 && b.owner >= 0 && b.inHands && prevSpeed > 6) {
    out.push({ type: 'catch', power: clamp01((prevSpeed - 6) / 20) });
    if (prevSpeed > 16) out.push({ type: 'ooh', power: clamp01((prevSpeed - 16) / 12) });
    return out;
  }

  // Tackles: a lunge starting, or the ball being won.
  const wonTackle = next.stats[0].tackles + next.stats[1].tackles > prev.tackles;
  const lunged = snapshotLunges(next) > prev.lunges;
  if (wonTackle || lunged) out.push({ type: 'tackle', won: wonTackle });

  // Kicks: the ball leaves a player's feet.
  if (prev.owner >= 0 && b.owner < 0 && !wonTackle && speed > 5) {
    if (b.passFrom >= 0) out.push({ type: 'kick', kind: 'pass', power: clamp01((speed - 8) / 15) });
    else out.push({ type: 'kick', kind: 'shot', power: clamp01((speed - 12) / 19) });
    return out;
  }

  // A header: a loose ball up at head height turned sharply, near a player.
  if (prev.owner < 0 && b.owner < 0 && prev.bz > 1.3 && prevSpeed > SPEED_NOISE && turned(prev, b.vel.x, b.vel.y) && headed(next)) {
    out.push({ type: 'header', power: clamp01(speed / 20) });
    return out;
  }

  // Ball against the furniture: only while loose before and after.
  if (prev.owner < 0 && b.owner < 0 && prevSpeed > SPEED_NOISE && b.pos.x >= 0 && b.pos.x <= PITCH_W) {
    for (const post of POSTS) {
      if (Math.hypot(b.pos.x - post.x, b.pos.y - post.y) < 0.75 && turned(prev, b.vel.x, b.vel.y)) {
        out.push({ type: 'knock', kind: 'post', power: clamp01(prevSpeed / 24) });
        return out;
      }
    }
    const nearY = b.pos.y < 1 || b.pos.y > PITCH_H - 1;
    const nearX = b.pos.x < 1 || b.pos.x > PITCH_W - 1;
    const flipY = nearY && prev.vy * b.vel.y < 0;
    const flipX = nearX && prev.vx * b.vel.x < 0;
    if (flipY || flipX) out.push({ type: 'knock', kind: 'board', power: clamp01(prevSpeed / 24) });
  }
  return out;
}

/** Was the ball, just before it went out, a shot going past within NEAR_MISS m of a post? */
function nearMiss(prev: Snapshot, speed: number): boolean {
  if (speed < 10) return false;
  const nearLine = prev.bx < 6 || prev.bx > PITCH_W - 6;
  const wide = Math.max(GOAL_TOP - prev.by, prev.by - GOAL_BOTTOM, 0);
  return nearLine && wide < NEAR_MISS;
}
/** How far outside a post (m) a shot still draws an "ooh" (over the bar counts as 0 wide). */
const NEAR_MISS = 4;

/** Is any player close enough to the ball (in the plane) to have headed it? */
function headed(s: MatchState): boolean {
  for (const p of s.players) if (Math.hypot(p.pos.x - s.ball.pos.x, p.pos.y - s.ball.pos.y) < 1.4) return true;
  return false;
}

function snapshotLunges(s: MatchState): number {
  let n = 0;
  for (const p of s.players) if (p.tackleCd >= LUNGE_CD) n++;
  return n;
}

/** Did the ball's direction change sharply (a post glances or rebounds)? */
function turned(prev: Snapshot, vx: number, vy: number): boolean {
  const a = speedOf(prev.vx, prev.vy);
  const b = speedOf(vx, vy);
  if (a < 1e-6 || b < 1e-6) return false;
  return (prev.vx * vx + prev.vy * vy) / (a * b) < 0.9;
}

/**
 * How loud the crowd should be, 0..1. Rises as the ball nears either goal and
 * more so when it is inside a penalty box. Pure so it can be tested.
 */
export function crowdLevel(s: MatchState): number {
  if (s.phase === 'fulltime') return 0.2;
  const b = s.ball.pos;
  const d = Math.min(Math.hypot(b.x, b.y - PITCH_H / 2), Math.hypot(PITCH_W - b.x, b.y - PITCH_H / 2));
  const near = clamp01(1 - d / 24);
  const inBox = d < 10 ? 0.25 : 0;
  const breaking = Math.hypot(s.ball.vel.x, s.ball.vel.y) > 14 ? 0.1 : 0;
  return clamp01(Math.max(0.18 + 0.5 * near * near + inBox + breaking, 0.18 + 0.3 * tension(s)));
}

/** The side the stands are behind: the human's team (team 0 when it is CPU vs CPU or both are human). */
export const homeTeam = (s: MatchState): 0 | 1 => (s.humans[1] && !s.humans[0] ? 1 : 0);

/** 0..1: how tense the stands are. Rises from the 70th minute of a game still level or a goal apart, to full at the end. */
export function tension(s: MatchState): number {
  if (s.phase === 'fulltime' || s.half !== 2 || Math.abs(s.score[0] - s.score[1]) > 1) return 0;
  return clamp01((matchSeconds(s) - 4200) / 1200) * (s.score[0] === s.score[1] ? 1 : 0.8);
}

/** How the stands take a goal that is already on the board: 'for' the home side, 'against' it; big when it levels or settles it, or comes late. */
export function goalMood(s: MatchState, team: 0 | 1): { side: 'for' | 'against'; big: boolean } {
  const [a, b] = s.score;
  const gap = Math.abs(a - b);
  return { side: team === homeTeam(s) ? 'for' : 'against', big: gap === 0 || gap === 1 || matchSeconds(s) >= 4800 };
}

/** A goal the human's side let in (an own goal counts: `team` is the side it is credited to), except in a two-human
 *  match (both sides celebrate) or CPU v CPU. The scene tones down. */
export function isConceded(s: MatchState, g: { team: 0 | 1 }): boolean {
  if ((s.humans[0] && s.humans[1]) || (!s.humans[0] && !s.humans[1])) return false;
  return g.team !== homeTeam(s);
}

/** The full-time whistle's reaction: a home win, a home defeat, or a draw. */
export function resultMood(s: MatchState): 'win' | 'loss' | 'draw' {
  const h = homeTeam(s);
  const d = s.score[h] - s.score[1 - h];
  return d > 0 ? 'win' : d < 0 ? 'loss' : 'draw';
}

// ---------------------------------------------------------------------------
// UI stingers (pure note choice)

/** A short jingle for a reward moment outside the match: the result dialog and the level-up dialog. */
export type StingerKind = 'win' | 'draw' | 'loss' | 'levelup' | 'cup' | 'train';

export interface StingerNote {
  /** Hz */
  f: number;
  /** Seconds after the start. */
  at: number;
  dur: number;
  peak: number;
  wave: 'sine' | 'triangle';
}

/** Win: a bright major arpeggio. Draw: two soft, level notes. Loss: two low, gentle falling notes. Level-up: a longer rising run. */
export function stingerNotes(kind: StingerKind): StingerNote[] {
  const n = (f: number, at: number, dur: number, peak: number, wave: 'sine' | 'triangle' = 'triangle'): StingerNote => ({ f, at, dur, peak, wave });
  switch (kind) {
    case 'win':
      return [n(523.25, 0, 0.28, 0.2), n(659.25, 0.11, 0.28, 0.2), n(783.99, 0.22, 0.3, 0.2), n(1046.5, 0.33, 0.7, 0.24)];
    case 'draw':
      return [n(392, 0, 0.35, 0.14, 'sine'), n(392, 0.2, 0.6, 0.14, 'sine'), n(523.25, 0.2, 0.6, 0.08, 'sine')];
    case 'loss':
      return [n(220, 0, 0.45, 0.12, 'sine'), n(174.61, 0.28, 0.8, 0.12, 'sine')];
    case 'train':
      // Training or a signing: two short bright notes, a click of reward rather than a fanfare.
      return [n(659.25, 0, 0.14, 0.14), n(880, 0.09, 0.3, 0.16)];
    case 'cup':
      // A trophy: the level-up run with a full chord held at the top, so it sounds bigger than a win.
      return [
        n(523.25, 0, 0.26, 0.2), n(659.25, 0.1, 0.26, 0.2), n(783.99, 0.2, 0.26, 0.2), n(1046.5, 0.3, 0.3, 0.22), n(1318.5, 0.42, 0.3, 0.22),
        n(1568, 0.54, 1.1, 0.24), n(1046.5, 0.54, 1.1, 0.12, 'sine'), n(783.99, 0.54, 1.1, 0.1, 'sine'), n(2093, 0.7, 0.9, 0.12, 'sine'),
      ];
    case 'levelup':
      return [
        n(523.25, 0, 0.26, 0.2), n(659.25, 0.1, 0.26, 0.2), n(783.99, 0.2, 0.26, 0.2), n(1046.5, 0.3, 0.3, 0.22), n(1318.5, 0.42, 0.3, 0.22),
        n(1568, 0.54, 0.9, 0.24), n(1046.5, 0.54, 0.9, 0.1, 'sine'),
      ];
  }
}

/** The jingle's total length in seconds. */
export function stingerLength(kind: StingerKind): number {
  return Math.max(...stingerNotes(kind).map((x) => x.at + x.dur));
}

// ---------------------------------------------------------------------------
// Mix (pure tables and shapes)

/** Sub-mixes. Each bus's gain sets its level against the others; the voices below are written 0..1 within a bus. */
export const MIX = { crowd: 0.9, ball: 0.8, ref: 0.85, stinger: 1.5, ui: 0.18 } as const;
export type Bus = keyof typeof MIX;

/** Which bus carries an event: the stands' "ooh", the referee (whistle, cards, flag), or the ball and everything around it. */
export const busOf = (t: SfxEvent['type']): Bus => (t === 'whistle' || t === 'call' ? 'ref' : t === 'ooh' ? 'crowd' : 'ball');

/** Quiet menu sounds (they follow mute and volume, and sit far below everything in a match). */
export type UiKind = 'press' | 'on' | 'off' | 'ok' | 'warn';

export function uiNotes(kind: UiKind): StingerNote[] {
  const n = (f: number, at: number, dur: number, peak = 0.5): StingerNote => ({ f, at, dur, peak, wave: 'sine' });
  switch (kind) {
    case 'press':
      return [n(1320, 0, 0.05, 0.45)];
    case 'on':
      return [n(880, 0, 0.07), n(1320, 0.06, 0.1)];
    case 'off':
      return [n(1320, 0, 0.07, 0.4), n(880, 0.06, 0.1, 0.4)];
    case 'ok':
      return [n(1046.5, 0, 0.18, 0.4)];
    case 'warn':
      return [n(330, 0, 0.16, 0.55), n(262, 0.1, 0.22, 0.55)];
  }
}

/** A ball strike: sine body (Hz, falling), leather snap (noise band) and a low thud; hard strikes add a crack. Peaks within the ball bus. */
export interface KickVoice {
  f0: number;
  dur: number;
  body: number;
  snap: number;
  snapF: number;
  thud: number;
  crack: number;
}

export function kickVoice(kind: 'pass' | 'shot', power: number): KickVoice {
  const p = clamp01(power);
  const hard = clamp01((p - 0.7) / 0.3);
  return kind === 'shot'
    ? { f0: 150 + 100 * p, dur: 0.12 + 0.07 * p, body: 0.3 + 0.4 * p, snap: 0.1 + 0.18 * p, snapF: 2000 + 700 * p, thud: 0.12 + 0.1 * p, crack: 0.2 * hard }
    : { f0: 110 + 80 * p, dur: 0.08 + 0.03 * p, body: 0.14 + 0.22 * p, snap: 0.05 + 0.08 * p, snapF: 1500 + 400 * p, thud: 0.05 + 0.08 * p, crack: 0.1 * hard };
}

/** The crowd bed for an intensity 0..1: gain, band-pass centre and low-pass ceiling (Hz). */
export function crowdTarget(level: number): { gain: number; band: number; low: number } {
  const l = clamp01(level);
  return { gain: 0.07 + 0.2 * l + 0.075 * l * l, band: 420 + 700 * l, low: 1500 + 1300 * l };
}

/** Peak-safe soft clip: unchanged below the knee, then a smooth bend that never reaches 0.98. */
export function softClip(x: number): number {
  const a = Math.abs(x);
  if (a <= CLIP_KNEE) return x;
  const y = CLIP_KNEE + (0.98 - CLIP_KNEE) * Math.tanh((a - CLIP_KNEE) / (0.98 - CLIP_KNEE));
  return x < 0 ? -y : y;
}
const CLIP_KNEE = 0.6;

/** Noise generation: brownish, with the first `seam` samples blended into the tail's continuation so the loop has no step. */
export function crowdNoise(d: Float32Array, seam: number, rnd: () => number = Math.random): void {
  const len = d.length;
  const raw = new Float32Array(len + seam);
  let last = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = rnd() * 2 - 1;
    last = (last + 0.04 * w) / 1.04;
    raw[i] = 0.55 * w + 4 * last;
  }
  for (let i = 0; i < len; i++) d[i] = i < seam ? raw[i] * (i / seam) + raw[len + i] * (1 - i / seam) : raw[i];
}

// ---------------------------------------------------------------------------
// Engine (browser)

export const MUTE_KEY = 'derbyday.audio.muted.v1';
export const VOLUME_KEY = 'derbyday.audio.volume.v1';
const MASTER_GAIN = 0.55;

export function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** The volume setting, 0..1 (default 1). */
export function loadVolume(): number {
  try {
    const v = localStorage.getItem(VOLUME_KEY);
    const n = v === null ? 1 : Number(v);
    return Number.isFinite(n) ? clamp01(n) : 1;
  } catch {
    return 1;
  }
}

function saveMuted(v: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, v ? '1' : '0');
  } catch {
    /* private mode: the setting just won't persist */
  }
}

type Ctx = AudioContext;

export class SoundEngine {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private bed: AudioBuffer | null = null;
  private bus = {} as Record<Bus, GainNode>;
  /** When each sounding voice ends (context time); the length of the live ones is the polyphony. */
  private ends: number[] = [];
  private crowdLow: BiquadFilterNode | null = null;
  private crowdGain: GainNode | null = null;
  private crowdFilter: BiquadFilterNode | null = null;
  private crowdSrc: AudioBufferSourceNode | null = null;
  private crowdLfo: OscillatorNode | null = null;
  private roarUntil = 0;
  private afterRoar = false;
  private wokeAt = -1e9;
  private crowdLevelNow = 0;
  private lastCrowdPush = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Paused (pause menu, hidden tab): the context stays suspended, whatever wakes it. */
  private held = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPlayed = new Map<string, number>();
  private listeners = new Set<(muted: boolean) => void>();
  private _muted = loadMuted();
  private _volume = loadVolume();

  get muted(): boolean {
    return this._muted;
  }

  /** 0..1, remembered in this browser. Volume 0 is silent, but not the same as muted. */
  get volume(): number {
    return this._volume;
  }

  setVolume(v: number): void {
    this._volume = clamp01(v);
    try {
      localStorage.setItem(VOLUME_KEY, String(this._volume));
    } catch {
      /* private mode: the setting just won't persist */
    }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.gainNow(), this.ctx.currentTime, 0.03);
  }

  private gainNow(): number {
    return this._muted ? 0 : MASTER_GAIN * this._volume;
  }

  onChange(fn: (muted: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setMuted(v: boolean): void {
    this._muted = v;
    saveMuted(v);
    if (!v) this.unlock();
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.gainNow(), this.ctx.currentTime, 0.03);
    if (!v) this.ui('on');
    for (const fn of this.listeners) fn(v);
  }

  toggle(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  /** Create or resume the AudioContext. Call from a user gesture. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.build(this.ctx);
      }
      if (this.ctx.state === 'suspended' && !this.held) {
        this.wokeAt = performance.now();
        void this.ctx.resume().catch(() => {});
      }
    } catch {
      this.ctx = null;
    }
  }

  /**
   * Stop all sound while the match is paused or the tab hidden: suspending the context stops the
   * crowd bed, its murmur and the audio thread, rather than leaving a faint bed under the pause menu.
   */
  suspend(): void {
    this.held = true;
    if (this.ctx?.state === 'running') void this.ctx.suspend().catch(() => {});
  }

  /** Undo suspend(): play on. */
  resume(): void {
    this.held = false;
    this.unlock();
  }

  /** A reward jingle outside the match (result or level-up dialog). Silent when muted; scales with the volume setting like every other sound. */
  stinger(kind: StingerKind): void {
    if (this._muted || this._volume <= 0) return;
    this.unlock();
    const r = this.ready('stinger');
    if (!r) return;
    try {
      this.notes(r.ctx, r.out, stingerNotes(kind));
    } catch {
      /* a failed sound must never break the UI */
    }
    // Let it ring out before the context sleeps again (nothing else is playing between matches).
    this.idle(Math.ceil(stingerLength(kind) * 1000) + 500);
  }

  /** A quiet menu sound (button, toggle, toast). Follows mute and volume; silent while paused or when the audio is asleep and no gesture woke it. */
  ui(kind: UiKind): void {
    if (this._muted || this._volume <= 0 || this.held) return;
    const now = performance.now();
    const key = `ui:${kind}`;
    if (now - (this.lastPlayed.get(key) ?? -1e9) < 50) return;
    this.lastPlayed.set(key, now);
    if (kind === 'press' || kind === 'on') this.unlock();
    const r = this.ready('ui');
    // Awake, or woken by this very gesture (a toast right after a click); a sleeping context stays asleep.
    if (!r || this.voices > 12 || (r.ctx.state !== 'running' && now - this.wokeAt > 400)) return;
    try {
      this.notes(r.ctx, r.out, uiNotes(kind), 0.004);
    } catch {
      /* a failed sound must never break the UI */
    }
    this.idle(1500);
  }

  private notes(ctx: Ctx, out: AudioNode, list: StingerNote[], atk = 0.008): void {
    const t = ctx.currentTime + 0.02;
    for (const x of list) this.tone(ctx, out, t + x.at, x.wave, x.f, x.f, x.dur, x.peak, atk);
  }

  /** Nothing to play (the match is over): once the crowd has faded out, suspend the context until the next match. */
  idle(afterMs = 1200): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.crowdSrc && this.ctx?.state === 'running') void this.ctx.suspend().catch(() => {});
    }, afterMs);
  }

  private build(ctx: Ctx): void {
    // Master gain into a soft clipper (no pumping, no makeup gain, and nothing can reach full scale), then out.
    const master = ctx.createGain();
    master.gain.value = this.gainNow();
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) curve[i] = softClip((i / 1024) - 1);
    clip.curve = curve;
    clip.oversample = '2x';
    master.connect(clip).connect(ctx.destination);
    this.master = master;
    for (const k of Object.keys(MIX) as Bus[]) {
      const g = ctx.createGain();
      g.gain.value = MIX[k];
      g.connect(master);
      this.bus[k] = g;
    }

    const len = ctx.sampleRate * 2;
    const seam = 2048;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    crowdNoise(this.noise.getChannelData(0), seam);
    // The bed is stereo (decorrelated sides) so the stands sit around the listener; one-shot noise stays centred.
    this.bed = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) crowdNoise(this.bed.getChannelData(c), seam);
  }

  private ready(bus: Bus = 'ball'): { ctx: Ctx; out: GainNode } | null {
    if (this._muted || !this.ctx || !this.master || this.ctx.state === 'closed') return null;
    return { ctx: this.ctx, out: this.bus[bus] };
  }

  /** Freeze a param at its current value from time t, so the next ramp starts there (no jump back). */
  private hold(p: AudioParam, t: number): void {
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
    else {
      const v = p.value;
      p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
    }
  }

  /** Dip the stands for a moment under a whistle or a card so it cuts through, then let them back. */
  private duck(ctx: Ctx, dur: number): void {
    const g = this.bus.crowd.gain;
    const t = ctx.currentTime;
    this.hold(g, t);
    g.setTargetAtTime(MIX.crowd * 0.6, t, 0.03);
    g.setTargetAtTime(MIX.crowd, t + dur, 0.25);
  }

  // -- crowd ---------------------------------------------------------------

  /** Begin the crowd bed. Safe to call repeatedly. */
  startCrowd(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.held = false;
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.bed || this.crowdSrc) return;
    const src = ctx.createBufferSource();
    src.buffer = this.bed;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 520;
    band.Q.value = 0.45;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 1800;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // Slow murmur so the bed breathes: it scales the level (a few %) and drifts the colour, never adds to a silent bed.
    const breath = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const depth = ctx.createGain();
    depth.gain.value = 0.1;
    const drift = ctx.createGain();
    drift.gain.value = 45;
    lfo.connect(depth).connect(breath.gain);
    lfo.connect(drift).connect(band.frequency);
    lfo.start();
    src.connect(band).connect(low).connect(gain).connect(breath).connect(this.bus.crowd);
    src.start();
    this.crowdSrc = src;
    this.crowdLfo = lfo;
    this.crowdGain = gain;
    this.crowdFilter = band;
    this.crowdLow = low;
    // If the caller stops feeding levels (paused, tab hidden), fade out.
    this.watchdog = setInterval(() => {
      if (performance.now() - this.lastCrowdPush > 500) this.applyCrowd(0, true);
    }, 250);
  }

  /** 0..1 intensity, pushed from the match loop. */
  setCrowd(level: number): void {
    this.lastCrowdPush = performance.now();
    if (!this.crowdSrc) return;
    this.applyCrowd(level);
  }

  /** silent: no feed (paused, hidden): fade the bed right out, not to its quiet floor. */
  private applyCrowd(level: number, silent = false): void {
    if (!this.ctx || !this.crowdGain || !this.crowdFilter || !this.crowdLow) return;
    const target = silent ? -1 : level;
    if (performance.now() < this.roarUntil || Math.abs(target - this.crowdLevelNow) < 0.01) return;
    this.crowdLevelNow = target;
    const t = this.ctx.currentTime;
    const c = crowdTarget(level);
    // The slow time constant after a roar is the stands settling, not a switch.
    const tc = this.afterRoar ? 1.1 : 0.4;
    this.afterRoar = false;
    for (const [p, v] of [[this.crowdGain.gain, silent ? 0 : c.gain], [this.crowdFilter.frequency, c.band], [this.crowdLow.frequency, c.low]] as const) {
      this.hold(p, t);
      p.setTargetAtTime(v, t, tc);
    }
  }

  stopCrowd(): void {
    this.held = false; // the match is over (a paused one leaves through here): the menus may sound again
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const src = this.crowdSrc;
    const ctx = this.ctx;
    if (src && ctx && this.crowdGain) {
      this.hold(this.crowdGain.gain, ctx.currentTime);
      this.crowdGain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      try {
        src.stop(ctx.currentTime + 1.5);
        this.crowdLfo?.stop(ctx.currentTime + 1.5);
      } catch {
        /* already stopped */
      }
    }
    this.crowdSrc = null;
    this.crowdLfo = null;
    this.crowdGain = null;
    this.crowdFilter = null;
    this.crowdLow = null;
    this.crowdLevelNow = 0;
  }

  /** A roar swells over a third of a second (it is a crowd, not a switch), holds, then settles back slowly. */
  private roar(strength: number, hold = 1800): void {
    const r = this.ready();
    if (!r || !this.crowdGain || !this.crowdFilter || !this.crowdLow) return;
    const t = r.ctx.currentTime;
    for (const [p, v, tc] of [[this.crowdGain.gain, 0.25 + 0.45 * strength, 0.14], [this.crowdFilter.frequency, 1300, 0.2], [this.crowdLow.frequency, 3200, 0.2]] as const) {
      this.hold(p, t);
      p.setTargetAtTime(v, t, tc);
    }
    this.roarUntil = performance.now() + hold;
    this.crowdLevelNow = -1;
    this.afterRoar = true;
  }

  /** The stands' reaction to a goal (for or against the home side) or the final whistle; the goal's net sound plays separately. `swell` (1, 2) holds a home cheer longer for a big moment. */
  react(kind: 'for' | 'against' | 'win' | 'loss' | 'draw', big = false, swell = 0): void {
    const r = this.ready();
    if (!r) return;
    try {
      if (kind === 'for' || kind === 'win') this.roar(kind === 'win' ? 0.8 : big ? 1 : 0.7, (big || kind === 'win' ? 3600 : 1800) + swell * 1500);
      else if (kind === 'against' || kind === 'loss') {
        // Away fans' small cheer is the roar at a lower strength; the home end groans under it.
        this.roar(kind === 'loss' ? 0.1 : 0.3, 1200);
        this.ooh(r.ctx, this.bus.crowd, 0, 0.7);
      } else this.roar(0.3, 1500);
    } catch {
      /* a failed sound must never break the match */
    }
  }

  // -- one-shots -------------------------------------------------------------

  play(ev: SfxEvent): void {
    const r = this.ready(busOf(ev.type));
    if (!r) return;
    // Cap concurrent voices: small contact sounds go first when a flurry is already sounding.
    const minor = ev.type === 'knock' || ev.type === 'tackle' || ev.type === 'header' || ev.type === 'ooh';
    if (this.voices > (minor ? 18 : 34)) return;
    const now = performance.now();
    const key = ev.type === 'kick' || ev.type === 'knock' ? `${ev.type}${'kind' in ev ? ev.kind : ''}` : ev.type;
    const gap = ev.type === 'knock' ? 60 : ev.type === 'kick' ? 40 : ev.type === 'ooh' ? 1500 : 0;
    if (gap && now - (this.lastPlayed.get(key) ?? -1e9) < gap) return;
    this.lastPlayed.set(key, now);
    try {
      switch (ev.type) {
        case 'kick':
          this.kick(r.ctx, r.out, ev.kind, ev.power);
          break;
        case 'knock':
          this.knock(r.ctx, r.out, ev.kind, ev.power);
          break;
        case 'tackle':
          this.tackle(r.ctx, r.out, ev.won);
          break;
        case 'goal':
          this.goal(r.ctx, r.out);
          break;
        case 'whistle':
          this.whistle(r.ctx, r.out, ev.kind);
          break;
        case 'ooh':
          this.ooh(r.ctx, r.out, ev.power);
          break;
        case 'catch':
          this.gather(r.ctx, r.out, ev.power);
          break;
        case 'call':
          this.call(r.ctx, r.out, ev.kind);
          break;
        case 'header':
          this.tone(r.ctx, r.out, r.ctx.currentTime, 'sine', 210 + 60 * ev.power, 90, 0.07, 0.22 + 0.2 * ev.power);
          this.burst(r.ctx, r.out, r.ctx.currentTime, 0.04, 'lowpass', 900, 300, 0.7, 0.12);
          break;
      }
    } catch {
      /* a failed sound must never break the match */
    }
  }

  private env(ctx: Ctx, out: AudioNode, at: number, peak: number, attack: number, decay: number): GainNode {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.gain.setValueAtTime(0, at + attack + decay);
    g.connect(out);
    return g;
  }

  private burst(ctx: Ctx, out: AudioNode, at: number, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, at);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    src.connect(f).connect(this.env(ctx, out, at, peak, 0.004, dur));
    src.start(at, Math.random() * 1.5);
    src.stop(at + dur + 0.05);
    this.ends.push(at + dur + 0.05);
  }

  /** Voices sounding now (dead ones are dropped as a side effect). */
  private get voices(): number {
    const t = this.ctx?.currentTime ?? 0;
    return (this.ends = this.ends.filter((e) => e > t)).length;
  }

  private tone(ctx: Ctx, out: AudioNode, at: number, type: OscillatorType, f0: number, f1: number, dur: number, peak: number, atk = 0.003): void {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    o.connect(this.env(ctx, out, at, peak, atk, dur));
    o.start(at);
    o.stop(at + dur + 0.05);
    this.ends.push(at + dur + 0.05);
  }

  private kick(ctx: Ctx, out: AudioNode, kind: 'pass' | 'shot', power: number): void {
    const t = ctx.currentTime;
    const v = kickVoice(kind, power);
    // Each strike a touch different (a few % in pitch).
    const j = 0.94 + Math.random() * 0.12;
    if (v.crack > 0) this.burst(ctx, out, t, 0.025, 'highpass', 3200, 3200, 0.8, v.crack);
    this.tone(ctx, out, t, 'sine', v.f0 * j, 48, v.dur, v.body);
    this.burst(ctx, out, t, kind === 'shot' ? 0.05 : 0.035, 'bandpass', v.snapF, 800, 0.9, v.snap);
    this.burst(ctx, out, t, kind === 'shot' ? 0.09 : 0.06, 'lowpass', 600, 160, 0.7, v.thud);
  }

  private knock(ctx: Ctx, out: AudioNode, kind: 'board' | 'post', power: number): void {
    const t = ctx.currentTime;
    const v = 0.09 + 0.22 * power;
    if (kind === 'board') {
      this.tone(ctx, out, t, 'triangle', 240, 110, 0.07, v);
      this.burst(ctx, out, t, 0.05, 'bandpass', 1100, 500, 1.2, v * 0.7);
    } else {
      // Metal ring: inharmonic partials, long-ish decay.
      for (const [f, m, d] of [[1180, 1, 0.55], [1930, 0.55, 0.4], [3110, 0.3, 0.25]] as const) this.tone(ctx, out, t, 'sine', f, f * 0.995, d, v * 0.7 * m);
      this.burst(ctx, out, t, 0.03, 'highpass', 2500, 2500, 0.7, v * 0.5);
    }
  }

  private tackle(ctx: Ctx, out: AudioNode, won: boolean): void {
    const t = ctx.currentTime;
    this.burst(ctx, out, t, 0.13, 'bandpass', 2200, 500, 0.9, won ? 0.28 : 0.16);
    if (won) this.tone(ctx, out, t, 'sine', 110, 60, 0.1, 0.3);
  }

  private goal(ctx: Ctx, out: AudioNode): void {
    const t = ctx.currentTime;
    // Net ripple: a few shimmering swishes that fade, plus a soft thud into the net.
    this.tone(ctx, out, t, 'sine', 90, 45, 0.18, 0.35);
    for (let i = 0; i < 6; i++) {
      const at = t + i * 0.085;
      this.burst(ctx, out, at, 0.16, 'bandpass', 3800 - i * 350, 1800, 1.4, 0.2 * Math.pow(0.72, i));
    }
    this.roar(1);
  }

  /** The crowd's "ooh": a vowel-like swell (noise through a falling formant) over the bed. */
  private ooh(ctx: Ctx, out: AudioNode, power: number, pitch = 1): void {
    const t = ctx.currentTime;
    const peak = 0.34 + 0.34 * power;
    const dur = pitch < 1 ? 1.5 : 1.1;
    for (const [f0, f1, q, m] of [[620, 380, 3, 1], [1150, 820, 4, 0.45]] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = q;
      f.frequency.setValueAtTime(f0 * pitch, t);
      f.frequency.exponentialRampToValueAtTime(f1 * pitch, t + dur);
      src.connect(f).connect(this.env(ctx, out, t, peak * m, 0.18, dur));
      src.start(t, Math.random() * 1.5);
      src.stop(t + dur + 0.25);
    }
  }

  /** A keeper gathering the ball: a muffled thump into the gloves. */
  private gather(ctx: Ctx, out: AudioNode, power: number): void {
    const t = ctx.currentTime;
    this.tone(ctx, out, t, 'sine', 150 + 40 * power, 70, 0.1, 0.24 + 0.2 * power);
    this.burst(ctx, out, t, 0.06, 'lowpass', 700, 250, 0.7, 0.11 + 0.08 * power);
  }

  /** A card, flag or penalty: a low thud under the (already sounding) whistle; red is heavier with a second blast. */
  private call(ctx: Ctx, out: AudioNode, kind: CallKind): void {
    const t = ctx.currentTime + 0.01;
    if (kind === 'offside') {
      // The flag's two-note chirp.
      this.tone(ctx, out, t, 'triangle', 880, 880, 0.08, 0.18);
      this.tone(ctx, out, t + 0.1, 'triangle', 1175, 1175, 0.1, 0.18);
    } else if (kind === 'penalty') {
      this.tone(ctx, out, t, 'sine', 110, 60, 0.25, 0.35);
      this.blast(ctx, out, t + 0.05, 0.5);
      this.duck(ctx, 0.55);
    } else {
      const red = kind === 'red';
      this.tone(ctx, out, t, 'sine', red ? 95 : 140, red ? 45 : 70, red ? 0.35 : 0.2, red ? 0.4 : 0.3);
      this.blast(ctx, out, t + 0.04, 0.25);
      if (red) this.blast(ctx, out, t + 0.4, 0.3);
      this.duck(ctx, red ? 0.7 : 0.3);
    }
  }

  private whistle(ctx: Ctx, out: AudioNode, kind: WhistleKind): void {
    const t = ctx.currentTime + 0.01;
    const blasts: [number, number][] =
      kind === 'foul'
        ? [[0, 0.18]]
        : kind === 'kickoff'
          ? [[0, 0.26]]
          : kind === 'halftime'
            ? [[0, 0.42], [0.58, 0.42]]
            : [[0, 0.32], [0.46, 0.32], [0.92, 0.7]];
    for (const [off, dur] of blasts) this.blast(ctx, out, t + off, dur);
    const [last, d] = blasts[blasts.length - 1];
    this.duck(ctx, last + d);
  }

  /** One pea-whistle blast: a high tone with fast flutter plus breathy noise. */
  private blast(ctx: Ctx, out: AudioNode, at: number, dur: number): void {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.35, at + 0.02);
    g.gain.setValueAtTime(0.35, at + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.gain.setValueAtTime(0, at + dur);
    g.connect(out);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(2850, at);
    o.frequency.linearRampToValueAtTime(3050, at + 0.05);
    // Pea flutter: frequency wobble at ~35 Hz.
    const wob = ctx.createOscillator();
    wob.frequency.value = 35;
    const wobDepth = ctx.createGain();
    wobDepth.gain.value = 70;
    wob.connect(wobDepth).connect(o.frequency);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = 5700;
    const o2g = ctx.createGain();
    o2g.gain.value = 0.15;
    o.connect(g);
    o2.connect(o2g).connect(g);
    for (const x of [o, wob, o2]) {
      x.start(at);
      x.stop(at + dur + 0.05);
    }
    this.burst(ctx, out, at, dur, 'bandpass', 3200, 3200, 3, 0.06);
  }
}

let shared: SoundEngine | null = null;
/** One engine for the whole page, so the AudioContext survives between matches. */
export function getSound(): SoundEngine {
  return (shared ??= new SoundEngine());
}
