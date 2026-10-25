// Synthesised sound for matches. Nothing is downloaded: every sound is built
// from oscillators and filtered noise with the Web Audio API at runtime.
//
// Two halves:
//   detectSfx()   pure. Diffs a tiny Snapshot against the next MatchState and
//                 returns what a spectator would hear. Unit-tested.
//   SoundEngine   browser only. Starts lazily after a user gesture, owns the
//                 master gain, mute setting and the crowd bed.

import { GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W } from '../sim/constants.ts';
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
}

export type SfxEvent =
  | { type: 'kick'; kind: 'pass' | 'shot'; power: number }
  | { type: 'knock'; kind: 'board' | 'post'; power: number }
  | { type: 'tackle'; won: boolean }
  | { type: 'goal'; team: 0 | 1 }
  | { type: 'whistle'; kind: WhistleKind };

/** 'foul': one short blast when the referee stops play for a foul, an offside, an advantage brought back or a second touch. */
export type WhistleKind = 'kickoff' | 'halftime' | 'fulltime' | 'foul';

/** A tackle sets tackleCd to 36 (win/neutral) or 50 (lost) on the tick it starts. */
const LUNGE_CD = 36;
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
  if (prev.phase !== 'play' && prev.phase !== 'init') return out;

  const speed = speedOf(b.vel.x, b.vel.y);
  const prevSpeed = speedOf(prev.vx, prev.vy);

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
  return clamp01(0.18 + 0.5 * near * near + inBox + breaking);
}

// ---------------------------------------------------------------------------
// Engine (browser)

export const MUTE_KEY = 'derbyday.audio.muted.v1';
const MASTER_GAIN = 0.55;

export function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
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
  private crowdGain: GainNode | null = null;
  private crowdFilter: BiquadFilterNode | null = null;
  private crowdSrc: AudioBufferSourceNode | null = null;
  private crowdLfo: OscillatorNode | null = null;
  private roarUntil = 0;
  private crowdLevelNow = 0;
  private lastCrowdPush = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Paused (pause menu, hidden tab): the context stays suspended, whatever wakes it. */
  private held = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPlayed = new Map<string, number>();
  private listeners = new Set<(muted: boolean) => void>();
  private _muted = loadMuted();

  get muted(): boolean {
    return this._muted;
  }

  onChange(fn: (muted: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setMuted(v: boolean): void {
    this._muted = v;
    saveMuted(v);
    if (!v) this.unlock();
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v ? 0 : MASTER_GAIN, this.ctx.currentTime, 0.03);
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
      if (this.ctx.state === 'suspended' && !this.held) void this.ctx.resume().catch(() => {});
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

  /** Nothing to play (the match is over): once the crowd has faded out, suspend the context until the next match. */
  idle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.crowdSrc && this.ctx?.state === 'running') void this.ctx.suspend().catch(() => {});
    }, 1200);
  }

  private build(ctx: Ctx): void {
    // Master chain: gain into a gentle limiter so stacked sounds can't clip.
    const master = ctx.createGain();
    master.gain.value = this._muted ? 0 : MASTER_GAIN;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 12;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    master.connect(limiter).connect(ctx.destination);
    this.master = master;

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Brownish-white mix: warmer than pure white noise, so the crowd isn't hissy.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.04 * w) / 1.04;
      d[i] = 0.55 * w + 4 * last;
    }
    this.noise = buf;
  }

  private ready(): { ctx: Ctx; out: GainNode } | null {
    if (this._muted || !this.ctx || !this.master || this.ctx.state === 'closed') return null;
    return { ctx: this.ctx, out: this.master };
  }

  // -- crowd ---------------------------------------------------------------

  /** Begin the crowd bed. Safe to call repeatedly. */
  startCrowd(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.held = false;
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.crowdSrc) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
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
    // Slow murmur so the bed breathes.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.012;
    lfo.connect(lfoDepth).connect(gain.gain);
    lfo.start();
    src.connect(band).connect(low).connect(gain).connect(this.master);
    src.start();
    this.crowdSrc = src;
    this.crowdLfo = lfo;
    this.crowdGain = gain;
    this.crowdFilter = band;
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
    if (!this.ctx || !this.crowdGain || !this.crowdFilter) return;
    const target = silent ? -1 : level;
    if (performance.now() < this.roarUntil || Math.abs(target - this.crowdLevelNow) < 0.01) return;
    this.crowdLevelNow = target;
    const t = this.ctx.currentTime;
    this.crowdGain.gain.cancelScheduledValues(t);
    this.crowdFilter.frequency.cancelScheduledValues(t);
    this.crowdGain.gain.setTargetAtTime(silent ? 0 : 0.02 + 0.11 * level, t, 0.4);
    this.crowdFilter.frequency.setTargetAtTime(420 + 700 * level, t, 0.4);
  }

  stopCrowd(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const src = this.crowdSrc;
    const ctx = this.ctx;
    if (src && ctx && this.crowdGain) {
      this.crowdGain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      try {
        src.stop(ctx.currentTime + 1);
        this.crowdLfo?.stop(ctx.currentTime + 1);
      } catch {
        /* already stopped */
      }
    }
    this.crowdSrc = null;
    this.crowdLfo = null;
    this.crowdGain = null;
    this.crowdFilter = null;
    this.crowdLevelNow = 0;
  }

  private roar(strength: number): void {
    const r = this.ready();
    if (!r || !this.crowdGain || !this.crowdFilter) return;
    const { ctx } = r;
    const t = ctx.currentTime;
    const g = this.crowdGain.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.09 + 0.2 * strength, t, 0.12);
    this.crowdFilter.frequency.cancelScheduledValues(t);
    this.crowdFilter.frequency.setTargetAtTime(1400, t, 0.15);
    // Hold the roar, then let setCrowd settle the bed back down (slowly, via its time constant).
    this.roarUntil = performance.now() + 1800;
    this.crowdLevelNow = -1;
  }

  // -- one-shots -------------------------------------------------------------

  play(ev: SfxEvent): void {
    const r = this.ready();
    if (!r) return;
    const now = performance.now();
    const key = ev.type === 'kick' || ev.type === 'knock' ? `${ev.type}${'kind' in ev ? ev.kind : ''}` : ev.type;
    const gap = ev.type === 'knock' ? 60 : ev.type === 'kick' ? 40 : 0;
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
  }

  private tone(ctx: Ctx, out: AudioNode, at: number, type: OscillatorType, f0: number, f1: number, dur: number, peak: number): void {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    o.connect(this.env(ctx, out, at, peak, 0.003, dur));
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  private kick(ctx: Ctx, out: AudioNode, kind: 'pass' | 'shot', power: number): void {
    const t = ctx.currentTime;
    if (kind === 'shot') {
      this.tone(ctx, out, t, 'sine', 170 + 90 * power, 48, 0.14 + 0.06 * power, 0.5 + 0.35 * power);
      this.burst(ctx, out, t, 0.05, 'bandpass', 2400, 900, 0.8, 0.22 + 0.2 * power);
      this.burst(ctx, out, t, 0.09, 'lowpass', 600, 160, 0.7, 0.2);
    } else {
      this.tone(ctx, out, t, 'sine', 120 + 90 * power, 55, 0.09, 0.28 + 0.25 * power);
      this.burst(ctx, out, t, 0.035, 'bandpass', 1800, 800, 0.9, 0.1 + 0.1 * power);
    }
  }

  private knock(ctx: Ctx, out: AudioNode, kind: 'board' | 'post', power: number): void {
    const t = ctx.currentTime;
    const v = 0.12 + 0.3 * power;
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
  }

  /** One pea-whistle blast: a high tone with fast flutter plus breathy noise. */
  private blast(ctx: Ctx, out: AudioNode, at: number, dur: number): void {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.2, at + 0.02);
    g.gain.setValueAtTime(0.2, at + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
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
