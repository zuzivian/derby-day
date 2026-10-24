// Match replays. The sim is deterministic (same seed + same per-tick input =
// same match), so a replay is just the match options plus the input log. No
// DOM here: the recorder, the compact code format and the seeker are pure and
// run under bun test. The viewer lives in src/client/replayView.ts.
//
// The only places this file touches the sim are createMatch(), step() and
// fingerprint(), all in `newMatch` / `advance` / `finalHash` below.

import { pack, unpack } from './pack.ts';
import { FORMATION_IDS, HALF_SECONDS, SIM_VERSION, TEAM_SIZE, TICK_HZ, type Role } from '../sim/constants.ts';
import { createMatch, fingerprint, step, type MatchOptions } from '../sim/match.ts';
import type { HumanInput, MatchState, PlayerSetup, SimAttrs, TeamSetup } from '../sim/types.ts';

// ---------------------------------------------------------------------------
// Types

export interface ReplayGoal {
  tick: number;
  team: 0 | 1;
  minute: number;
  scorer: string;
}

/** `n` consecutive ticks with exactly this (already quantised) input. */
export interface InputRun {
  n: number;
  input: HumanInput;
}

export interface Replay {
  seed: number;
  halfSeconds: number;
  humanTeam: 0 | 1 | -1;
  home: TeamSetup;
  away: TeamSetup;
  /** Number of sim ticks recorded (the tick the match ended on). */
  ticks: number;
  runs: InputRun[];
  goals: ReplayGoal[];
  score: [number, number];
  /** 32-bit hash of fingerprint() at the last tick, to spot a replay from a different sim version. 0 = unknown. */
  fp: number;
  label: string;
  /** Unix seconds when it was played. */
  at: number;
  /**
   * SIM_VERSION of the engine it was recorded on. A replay from another
   * version still opens (six-a-side teams are padded to eleven) but plays a
   * different match, and the viewer says so.
   */
  sim: number;
}

export type ReplayOptions = Pick<MatchOptions, 'seed' | 'home' | 'away' | 'halfSeconds' | 'humanTeam'>;

// ---------------------------------------------------------------------------
// Input quantisation and run-length encoding

/** Cursor and axes are kept to 1 cm, shot power to 1%. */
const q100 = (v: number): number => Math.round(v * 100) / 100 || 0;

/**
 * The canonical form of an input: quantised, false/undefined fields dropped.
 * The live loop must step the sim with THIS, not the raw input, or a replay of
 * it would drift.
 */
export function quantiseInput(i: HumanInput): HumanInput {
  const o: HumanInput = {};
  if (i.cursor) o.cursor = { x: q100(i.cursor.x), y: q100(i.cursor.y) };
  if (i.dir) o.dir = { x: q100(i.dir.x), y: q100(i.dir.y) };
  if (i.pass) o.pass = true;
  if (i.loft !== undefined) o.loft = q100(Math.min(1, Math.max(0, i.loft)));
  if (i.shoot !== undefined) o.shoot = q100(Math.min(1, Math.max(0, i.shoot)));
  if (i.tackle) o.tackle = true;
  if (i.select) o.select = true;
  if (i.sprint) o.sprint = true;
  if (i.switchPlayer) o.switchPlayer = true;
  if (i.aim) o.aim = { x: q100(i.aim.x), y: q100(i.aim.y) };
  if (i.moved) o.moved = true;
  return o;
}

export function inputsEqual(a: HumanInput, b: HumanInput): boolean {
  return (
    a.cursor?.x === b.cursor?.x &&
    a.cursor?.y === b.cursor?.y &&
    a.dir?.x === b.dir?.x &&
    a.dir?.y === b.dir?.y &&
    a.pass === b.pass &&
    a.loft === b.loft &&
    a.shoot === b.shoot &&
    a.tackle === b.tackle &&
    a.select === b.select &&
    a.sprint === b.sprint &&
    a.switchPlayer === b.switchPlayer &&
    a.aim?.x === b.aim?.x &&
    a.aim?.y === b.aim?.y &&
    a.moved === b.moved &&
    !a.cursor === !b.cursor &&
    !a.dir === !b.dir &&
    !a.aim === !b.aim
  );
}

// ---------------------------------------------------------------------------
// Recorder

/** Wraps a live match: feed it every tick's input and step the sim with what it returns. */
export class ReplayRecorder {
  private runs: InputRun[] = [];
  private ticks = 0;
  private opts: ReplayOptions & { halfSeconds: number; humanTeam: 0 | 1 | -1 };

  constructor(o: ReplayOptions, private label = '') {
    // Same defaults as createMatch.
    this.opts = { seed: o.seed | 0, home: o.home, away: o.away, halfSeconds: o.halfSeconds ?? HALF_SECONDS, humanTeam: o.humanTeam ?? 0 };
  }

  get length(): number {
    return this.ticks;
  }

  /** Record one tick. Returns the quantised input to give to step(). */
  push(raw: HumanInput): HumanInput {
    const input = quantiseInput(raw);
    const last = this.runs[this.runs.length - 1];
    if (last && inputsEqual(last.input, input)) last.n++;
    else this.runs.push({ n: 1, input });
    this.ticks++;
    return input;
  }

  /** Close the recording against the final state. `at` is Unix seconds. */
  finish(s: MatchState, at: number): Replay {
    return {
      seed: this.opts.seed,
      halfSeconds: this.opts.halfSeconds,
      humanTeam: this.opts.humanTeam,
      home: this.opts.home,
      away: this.opts.away,
      ticks: this.ticks,
      runs: this.runs.map((r) => ({ n: r.n, input: r.input })),
      goals: s.goals.map((e) => ({ tick: e.tick, team: e.team, minute: e.minute, scorer: e.scorer })),
      score: [s.score[0], s.score[1]],
      fp: finalHash(s),
      label: this.label,
      at: Math.floor(at),
      sim: SIM_VERSION,
    };
  }
}

// ---------------------------------------------------------------------------
// Re-simulation (the only sim calls)

/**
 * A team recorded on an older engine (six-a-side) made up to eleven so it can
 * still be simulated: the outfield players are repeated. It won't be the match
 * that was played, and verification will say so.
 */
function elevenOf(t: TeamSetup): TeamSetup {
  if (t.players.length === TEAM_SIZE) return t;
  const players = t.players.slice(0, TEAM_SIZE);
  const outfield = t.players.filter((p) => p.role !== 'GK');
  for (let k = 0; players.length < TEAM_SIZE; k++) {
    const src = outfield[k % Math.max(1, outfield.length)] ?? t.players[0];
    players.push({ ...src, id: `${src.id}~${k}`, number: 30 + k });
  }
  // Slot order for the default formation: keeper first, then four defenders, four midfielders, two forwards.
  const order: Role[] = ['GK', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD'];
  return { ...t, formation: '4-4-2', players: order.map((role, i) => ({ ...players[i], role })) };
}

function newMatch(r: Replay): MatchState {
  // Cloned so the replay's own team data can never be touched by the sim.
  const home = elevenOf(structuredClone(r.home));
  const away = elevenOf(structuredClone(r.away));
  return createMatch({ seed: r.seed, home, away, halfSeconds: r.halfSeconds, humanTeam: r.humanTeam });
}

function advance(s: MatchState, input: HumanInput): void {
  step(s, input);
}

export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Never 0, so 0 can mean "not recorded". */
export function finalHash(s: MatchState): number {
  return hash32(fingerprint(s)) || 1;
}

/** One input per tick; runs share their input object. */
export function expandInputs(r: Replay): HumanInput[] {
  const out: HumanInput[] = new Array(r.ticks);
  let t = 0;
  for (const run of r.runs) for (let k = 0; k < run.n && t < r.ticks; k++) out[t++] = run.input;
  while (t < r.ticks) out[t++] = {};
  return out;
}

/** The match state at `tick`, rebuilt from tick 0. For random access use ReplaySeeker. */
export function replayTo(r: Replay, tick: number): MatchState {
  const s = newMatch(r);
  const inputs = expandInputs(r);
  const end = Math.max(0, Math.min(tick, r.ticks));
  while (s.tick < end) advance(s, inputs[s.tick]);
  return s;
}

// ---------------------------------------------------------------------------
// Seeking

export const KEYFRAME_EVERY = 600;
/** Highlight window around a goal: six seconds of build-up, then the celebration. */
export const GOAL_LEAD_TICKS = 6 * TICK_HZ;
export const GOAL_TAIL_TICKS = 90;

export interface Clip {
  kind: 'goal' | 'match';
  start: number;
  end: number;
  goal?: ReplayGoal;
  /** 1-based goal number, for goal clips. */
  n?: number;
}

/** One clip per goal, then the whole match. */
export function clipsFor(r: Replay): Clip[] {
  const clips: Clip[] = r.goals.map((g, i) => ({
    kind: 'goal' as const,
    start: Math.max(0, g.tick - GOAL_LEAD_TICKS),
    end: Math.min(r.ticks, g.tick + GOAL_TAIL_TICKS),
    goal: g,
    n: i + 1,
  }));
  clips.push({ kind: 'match', start: 0, end: r.ticks });
  return clips;
}

/**
 * Random access into a replay. A cloned state is kept every KEYFRAME_EVERY
 * ticks, so any seek costs a clone plus at most KEYFRAME_EVERY - 1 sim steps.
 * `warm()` fills every keyframe in the background and checks the final hash.
 */
export class ReplaySeeker {
  /** The state to draw. Replaced (not just mutated) by a seek that jumps. */
  state: MatchState;
  /** Sim steps run so far, for measuring. */
  steps = 0;
  /** After warm() has finished: did the re-simulation reach the recorded final hash? null = not finished or no hash. */
  verified: boolean | null = null;
  private frames = new Map<number, MatchState>();
  private inputs: HumanInput[];
  private warmState: MatchState | null;

  constructor(readonly replay: Replay) {
    const base = newMatch(replay);
    this.frames.set(0, base);
    this.state = structuredClone(base);
    this.warmState = structuredClone(base);
    this.inputs = expandInputs(replay);
  }

  get keyframes(): number {
    return this.frames.size;
  }

  get warmed(): boolean {
    return this.warmState === null;
  }

  /** How far the background pass has got, in ticks: keyframes exist up to here, so seeks below it are cheap. */
  get warmedTo(): number {
    return this.warmState ? this.warmState.tick : this.replay.ticks;
  }

  private stepOnce(s: MatchState): void {
    advance(s, this.inputs[s.tick] ?? {});
    this.steps++;
    if (s.tick % KEYFRAME_EVERY === 0 && !this.frames.has(s.tick)) this.frames.set(s.tick, structuredClone(s));
  }

  /** Move to `tick` (clamped to the replay) and return the state there. */
  seek(tick: number): MatchState {
    const target = Math.max(0, Math.min(Math.round(tick), this.replay.ticks));
    let k = Math.floor(target / KEYFRAME_EVERY) * KEYFRAME_EVERY;
    while (k > 0 && !this.frames.has(k)) k -= KEYFRAME_EVERY;
    if (this.state.tick > target || this.state.tick < k) this.state = structuredClone(this.frames.get(k)!);
    while (this.state.tick < target) this.stepOnce(this.state);
    return this.state;
  }

  /** Advance the shown state by one tick (live playback). */
  stepForward(): MatchState {
    if (this.state.tick < this.replay.ticks) this.stepOnce(this.state);
    return this.state;
  }

  /** Simulate up to `maxTicks` more of the background pass. Returns true once it has finished. */
  warm(maxTicks: number): boolean {
    const w = this.warmState;
    if (!w) return true;
    const end = this.replay.ticks;
    for (let i = 0; i < maxTicks && w.tick < end; i++) this.stepOnce(w);
    if (w.tick >= end) {
      // Another engine version never reproduces the match, even if a hash happened to collide.
      this.verified = this.replay.sim !== SIM_VERSION ? false : this.replay.fp ? finalHash(w) === this.replay.fp : null;
      this.warmState = null;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Compact code: binary body, base64url, "DD1." prefix, FNV checksum. Codes made
// under the game's earlier names start "OVR1." or "TB1." and decode the same way.

const PREFIX = 'DD1.';
const LEGACY_PREFIXES = ['OVR1.', 'TB1.'];
const MAX_TICKS = 600_000;
const ROLES: Role[] = ['GK', 'DEF', 'MID', 'FWD'];
const ATTRS: (keyof SimAttrs)[] = ['pace', 'shooting', 'passing', 'dribbling', 'defending', 'stamina', 'goalkeeping'];
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

class Writer {
  private buf = new Uint8Array(1024);
  private n = 0;
  private need(k: number) {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf);
    this.buf = b;
  }
  byte(v: number) {
    this.need(1);
    this.buf[this.n++] = v & 255;
  }
  /** Unsigned LEB128. Safe up to 2^53. */
  uvar(v: number) {
    let x = Math.floor(v);
    while (x >= 128) {
      this.byte((x % 128) | 128);
      x = Math.floor(x / 128);
    }
    this.byte(x);
  }
  ivar(v: number) {
    this.uvar(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  str(s: string) {
    const b = enc.encode(s);
    this.uvar(b.length);
    this.need(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  /** Exact thousandths cost one varint; anything else is a full float64. */
  num(v: number) {
    const k = Math.round(v * 1000);
    if (k >= 0 && k / 1000 === v && Number.isSafeInteger(k * 2 + 2)) this.uvar(k * 2);
    else {
      this.uvar(1);
      this.need(8);
      new DataView(this.buf.buffer).setFloat64(this.n, v, true);
      this.n += 8;
    }
  }
  u32(v: number) {
    for (let i = 0; i < 4; i++) this.byte((v >>> (8 * i)) & 255);
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

class Reader {
  private n = 0;
  constructor(private buf: Uint8Array) {}
  private fail(): never {
    throw new Error('Replay code is damaged or cut short.');
  }
  get done(): boolean {
    return this.n >= this.buf.length;
  }
  byte(): number {
    if (this.n >= this.buf.length) this.fail();
    return this.buf[this.n++];
  }
  uvar(): number {
    let x = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.byte();
      x += (b & 127) * mul;
      if (b < 128) return x;
      mul *= 128;
    }
    return this.fail();
  }
  ivar(): number {
    const z = this.uvar();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
  str(): string {
    const len = this.uvar();
    if (len > 200 || this.n + len > this.buf.length) this.fail();
    const s = dec.decode(this.buf.subarray(this.n, this.n + len));
    this.n += len;
    return s;
  }
  num(): number {
    const v = this.uvar();
    if (v === 1) {
      if (this.n + 8 > this.buf.length) this.fail();
      const f = new DataView(this.buf.buffer, this.buf.byteOffset + this.n, 8).getFloat64(0, true);
      this.n += 8;
      return f;
    }
    if (v % 2 !== 0) this.fail();
    return v / 2 / 1000;
  }
  u32(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) v += this.byte() * 2 ** (8 * i);
    return v;
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function writeColour(w: Writer, c: string) {
  if (HEX.test(c)) {
    w.byte(1);
    const n = parseInt(c.slice(1), 16);
    w.byte(n >> 16);
    w.byte(n >> 8);
    w.byte(n);
  } else {
    w.byte(0);
    w.str(c);
  }
}

function readColour(r: Reader): string {
  if (r.byte() === 1) return '#' + [r.byte(), r.byte(), r.byte()].map((b) => b.toString(16).padStart(2, '0')).join('');
  return r.str();
}

function writeTeam(w: Writer, t: TeamSetup) {
  w.str(t.name);
  w.str(t.short);
  writeColour(w, t.primary);
  writeColour(w, t.secondary);
  w.num(t.aiSkill);
  w.byte(Math.max(0, FORMATION_IDS.indexOf(t.formation ?? '4-4-2')));
  w.uvar(t.players.length);
  for (const p of t.players) {
    w.str(p.id);
    w.str(p.name);
    w.uvar(p.number);
    w.byte(ROLES.indexOf(p.role));
    for (const k of ATTRS) w.num(p.attrs[k]);
  }
}

/** `withFormation`: version 3 and later carry the formation; version 2 teams were six-a-side. */
function readTeam(r: Reader, withFormation: boolean): TeamSetup {
  const name = r.str();
  const short = r.str();
  const primary = readColour(r);
  const secondary = readColour(r);
  const aiSkill = r.num();
  const formation = withFormation ? FORMATION_IDS[r.byte()] : undefined;
  if (withFormation && !formation) throw new Error('Replay code is damaged or cut short.');
  const count = r.uvar();
  if (count < 1 || count > TEAM_SIZE) throw new Error('Replay code has the wrong squad size.');
  const players: PlayerSetup[] = [];
  for (let i = 0; i < count; i++) {
    const id = r.str();
    const pname = r.str();
    const number = r.uvar();
    const role = ROLES[r.byte()];
    if (!role) throw new Error('Replay code has an unknown role.');
    const attrs = {} as SimAttrs;
    for (const k of ATTRS) attrs[k] = r.num();
    players.push({ id, name: pname, number, role, attrs });
  }
  return formation ? { name, short, primary, secondary, players, aiSkill, formation } : { name, short, primary, secondary, players, aiSkill };
}

// Run flags. A tick that only moves the pointer is one flag byte plus two
// small deltas; a repeat count is only written when the run is longer than 1.
const F_CURSOR = 1;
const F_DIR = 2;
const F_PASS = 4;
const F_SPRINT = 8;
/** Format 4: the pointer really moved this tick. (Formats 2 and 3: switch player, now E_SWITCH.) */
const F_MOVED = 16;
const F_SWITCH_V3 = 16;
/** An extra byte follows with the rarer fields. */
const F_EXT = 32;
/** The run is longer than one tick; its length follows. */
const F_MULTI = 64;
const E_SELECT = 1;
const E_TACKLE = 2;
/** The shot power byte follows the extra byte. */
const E_SHOOT = 4;
/** The loft hold byte follows (after the shot byte, if any). */
const E_LOFT = 8;
/** Format 4: switch player (key scheme). */
const E_SWITCH = 16;
/** Format 4: an aim point follows the cursor and axes, delta-coded against the cursor. */
const E_AIM = 32;

function writeRuns(w: Writer, runs: InputRun[]) {
  // Cursor and axes are delta-coded against the previous run's, in whole cm.
  let cx = 0;
  let cy = 0;
  let dx = 0;
  let dy = 0;
  for (const { n, input: i } of runs) {
    let e = 0;
    if (i.select) e |= E_SELECT;
    if (i.tackle) e |= E_TACKLE;
    if (i.shoot !== undefined) e |= E_SHOOT;
    if (i.loft !== undefined) e |= E_LOFT;
    if (i.switchPlayer) e |= E_SWITCH;
    if (i.aim) e |= E_AIM;
    let f = 0;
    if (i.cursor) f |= F_CURSOR;
    if (i.dir) f |= F_DIR;
    if (i.pass) f |= F_PASS;
    if (i.sprint) f |= F_SPRINT;
    if (i.moved) f |= F_MOVED;
    if (e) f |= F_EXT;
    if (n > 1) f |= F_MULTI;
    w.byte(f);
    if (e) w.byte(e);
    if (i.shoot !== undefined) w.byte(Math.round(i.shoot * 100));
    if (i.loft !== undefined) w.byte(Math.round(i.loft * 100));
    if (i.cursor) {
      const x = Math.round(i.cursor.x * 100);
      const y = Math.round(i.cursor.y * 100);
      w.ivar(x - cx);
      w.ivar(y - cy);
      cx = x;
      cy = y;
    }
    if (i.dir) {
      const x = Math.round(i.dir.x * 100);
      const y = Math.round(i.dir.y * 100);
      w.ivar(x - dx);
      w.ivar(y - dy);
      dx = x;
      dy = y;
    }
    if (i.aim) {
      w.ivar(Math.round(i.aim.x * 100) - cx);
      w.ivar(Math.round(i.aim.y * 100) - cy);
    }
    if (n > 1) w.uvar(n);
  }
}

function readRuns(r: Reader, ticks: number, version: number): InputRun[] {
  const runs: InputRun[] = [];
  let cx = 0;
  let cy = 0;
  let dx = 0;
  let dy = 0;
  let total = 0;
  while (total < ticks) {
    const f = r.byte();
    if (f & 128) throw new Error('Replay code is damaged or cut short.');
    const e = f & F_EXT ? r.byte() : 0;
    const input: HumanInput = {};
    if (e & E_SHOOT) input.shoot = r.byte() / 100;
    if (e & E_LOFT) input.loft = r.byte() / 100;
    if (f & F_CURSOR) {
      cx += r.ivar();
      cy += r.ivar();
      input.cursor = { x: cx / 100, y: cy / 100 };
    }
    if (f & F_DIR) {
      dx += r.ivar();
      dy += r.ivar();
      input.dir = { x: dx / 100, y: dy / 100 };
    }
    if (version >= 4 && e & E_AIM) {
      const ax = cx + r.ivar();
      const ay = cy + r.ivar();
      input.aim = { x: ax / 100, y: ay / 100 };
    }
    if (f & F_PASS) input.pass = true;
    if (f & F_SPRINT) input.sprint = true;
    if (e & E_SELECT) input.select = true;
    if (e & E_TACKLE) input.tackle = true;
    if (version >= 4 ? e & E_SWITCH : f & F_SWITCH_V3) input.switchPlayer = true;
    if (version >= 4 && f & F_MOVED) input.moved = true;
    const n = f & F_MULTI ? r.uvar() : 1;
    if (n < 1 || total + n > ticks) throw new Error('Replay code is damaged or cut short.');
    runs.push({ n, input });
    total += n;
  }
  return runs;
}

function toBase64Url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(t: string): Uint8Array {
  const std = t.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function checksum(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Format version, the first byte of the body. 2: the pointer controls (loft, tackle, select
 * instead of through and chip, and a different meaning for the pointer's distance). Version 1
 * codes were recorded against the old controls and would not play back the same.
 * 3: eleven-a-side: each team carries its formation, and the body records the SIM_VERSION.
 * Version 2 codes (six-a-side) still open, but play back a different match and are flagged.
 * 4: inputs carry `aim` (a click aims where the button went down) and `moved` (the pointer
 * really moved); switch player moved to the extra byte to make room. Version 3 codes still
 * open (recorded on an earlier sim, so flagged as from another version).
 * 5: the input runs (the bulk of a code) are compressed with pack.ts, an adaptive range coder:
 * same inputs, about half the length, so five full matches fit the Recent shelf and a code is
 * easier to share. Version 4 codes still open unchanged.
 */
export const REPLAY_VERSION = 5;

export function encodeReplay(r: Replay): string {
  const w = new Writer();
  w.byte(REPLAY_VERSION);
  w.ivar(r.seed | 0);
  w.uvar(Math.round(r.halfSeconds * 1000));
  w.byte(r.humanTeam + 1);
  w.uvar(r.sim);
  writeTeam(w, r.home);
  writeTeam(w, r.away);
  w.str(r.label);
  w.uvar(r.at);
  w.uvar(r.score[0]);
  w.uvar(r.score[1]);
  w.uvar(r.goals.length);
  for (const g of r.goals) {
    w.uvar(g.tick);
    w.byte(g.team);
    w.uvar(g.minute);
    w.str(g.scorer);
  }
  w.u32(r.fp);
  w.uvar(r.ticks);
  // Format 5: the runs are written to their own buffer and packed.
  const rw = new Writer();
  writeRuns(rw, r.runs);
  const raw = rw.bytes();
  const packed = pack(raw);
  w.uvar(raw.length);
  w.uvar(packed.length);
  for (const b of packed) w.byte(b);
  const body = w.bytes();
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  new DataView(out.buffer).setUint32(body.length, checksum(body), true);
  return PREFIX + toBase64Url(out);
}

/** Throws an Error with a message fit to show the player when the code is not a valid replay. */
export function decodeReplay(code: string): Replay {
  try {
    return decodeBody(code);
  } catch (e) {
    // Reader/TextDecoder errors on garbage become one readable message; ours pass through.
    if (e instanceof Error && /^(Replay code|That is not)/.test(e.message)) throw e;
    throw new Error('Replay code is damaged or cut short.');
  }
}

function decodeBody(code: string): Replay {
  const text = code.replace(/\s+/g, '');
  const prefix = [PREFIX, ...LEGACY_PREFIXES].find((p) => text.startsWith(p));
  if (!prefix) throw new Error('That is not a Derby Day replay code.');
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text.slice(prefix.length));
  } catch {
    throw new Error('Replay code is damaged or cut short.');
  }
  if (bytes.length < 8) throw new Error('Replay code is damaged or cut short.');
  const body = bytes.subarray(0, bytes.length - 4);
  const want = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0, true);
  if (checksum(body) !== want) throw new Error('Replay code is damaged or cut short.');
  const r = new Reader(body);
  const version = r.byte();
  if (version < 2) throw new Error('Replay code is from an older version of the game, before the new controls, and can no longer be played back.');
  if (version > REPLAY_VERSION) throw new Error('Replay code is from a newer version of the game.');
  const seed = r.ivar() | 0;
  const halfSeconds = r.uvar() / 1000;
  const humanTeam = (r.byte() - 1) as 0 | 1 | -1;
  if (halfSeconds < 1 || halfSeconds > 3600 || ![-1, 0, 1].includes(humanTeam)) throw new Error('Replay code is damaged or cut short.');
  const sim = version >= 3 ? r.uvar() : 1;
  const home = readTeam(r, version >= 3);
  const away = readTeam(r, version >= 3);
  const label = r.str();
  const at = r.uvar();
  const score: [number, number] = [r.uvar(), r.uvar()];
  const goalCount = r.uvar();
  if (goalCount > 200) throw new Error('Replay code is damaged or cut short.');
  const goals: ReplayGoal[] = [];
  for (let i = 0; i < goalCount; i++) {
    const tick = r.uvar();
    const team = r.byte();
    if (team > 1) throw new Error('Replay code is damaged or cut short.');
    goals.push({ tick, team: team as 0 | 1, minute: r.uvar(), scorer: r.str() });
  }
  const fp = r.u32();
  const ticks = r.uvar();
  if (ticks > MAX_TICKS) throw new Error('Replay code is damaged or cut short.');
  let runs: InputRun[];
  if (version >= 5) {
    const rawLen = r.uvar();
    const packedLen = r.uvar();
    if (rawLen > MAX_TICKS * 32 || packedLen > rawLen + 64) throw new Error('Replay code is damaged or cut short.');
    const packed = new Uint8Array(packedLen);
    for (let i = 0; i < packedLen; i++) packed[i] = r.byte();
    const rr = new Reader(unpack(packed, rawLen));
    runs = readRuns(rr, ticks, version);
    if (!rr.done) throw new Error('Replay code is damaged or cut short.');
  } else runs = readRuns(r, ticks, version);
  if (!r.done) throw new Error('Replay code is damaged or cut short.');
  return { seed, halfSeconds, humanTeam, home, away, ticks, runs, goals, score, fp, label, at, sim };
}

/** Bytes of the code as the player would paste it. */
export const codeSize = (code: string): number => code.length;

export function formatSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

// ---------------------------------------------------------------------------
// Keeping the last few

export interface StoredReplay {
  id: string;
  at: number;
  code: string;
}

export const KEEP_REPLAYS = 5;
/**
 * Total characters of the stored JSON for KEEP_REPLAYS replays. A full match's code is about 45-70K
 * characters since format 5 (pack.ts; it was 70-117K), so five fit with room to spare, well within
 * a browser's roughly 5M characters of localStorage.
 */
export const KEEP_CHARS = 500_000;

/** Newest last. Adds `entry`, then drops the oldest until there are at most `maxCount` and the JSON fits `maxChars`. */
export function addRecent(list: StoredReplay[], entry: StoredReplay, maxCount = KEEP_REPLAYS, maxChars = KEEP_CHARS): StoredReplay[] {
  const next = [...list.filter((e) => e.id !== entry.id), entry];
  while (next.length > maxCount) next.shift();
  while (next.length > 0 && JSON.stringify(next).length > maxChars) next.shift();
  return next;
}

export function replayId(r: Replay): string {
  return `${r.at.toString(36)}${hash32(`${r.seed}|${r.fp}|${r.ticks}`).toString(36)}`;
}
