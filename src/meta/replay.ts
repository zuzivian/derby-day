// Match replays. The sim is deterministic (same seed + same per-tick input =
// same match), so a replay is just the match options plus the input log. No
// DOM here: the recorder, the compact code format and the seeker are pure and
// run under bun test. The viewer lives in src/client/replayView.ts.
//
// The only places this file touches the sim are createMatch(), step() and
// fingerprint(), all in `newMatch` / `advance` / `finalHash` below.

import { HALF_SECONDS, TEAM_SIZE, TICK_HZ, type Role } from '../sim/constants.ts';
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
  if (i.shoot !== undefined) o.shoot = q100(Math.min(1, Math.max(0, i.shoot)));
  if (i.sprint) o.sprint = true;
  if (i.through) o.through = true;
  if (i.chip) o.chip = true;
  if (i.switchPlayer) o.switchPlayer = true;
  return o;
}

export function inputsEqual(a: HumanInput, b: HumanInput): boolean {
  return (
    a.cursor?.x === b.cursor?.x &&
    a.cursor?.y === b.cursor?.y &&
    a.dir?.x === b.dir?.x &&
    a.dir?.y === b.dir?.y &&
    a.pass === b.pass &&
    a.shoot === b.shoot &&
    a.sprint === b.sprint &&
    a.through === b.through &&
    a.chip === b.chip &&
    a.switchPlayer === b.switchPlayer &&
    !a.cursor === !b.cursor &&
    !a.dir === !b.dir
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
      goals: s.events.map((e) => ({ tick: e.tick, team: e.team, minute: e.minute, scorer: e.scorer })),
      score: [s.score[0], s.score[1]],
      fp: finalHash(s),
      label: this.label,
      at: Math.floor(at),
    };
  }
}

// ---------------------------------------------------------------------------
// Re-simulation (the only sim calls)

function newMatch(r: Replay): MatchState {
  // Cloned so the replay's own team data can never be touched by the sim.
  return createMatch({ seed: r.seed, home: structuredClone(r.home), away: structuredClone(r.away), halfSeconds: r.halfSeconds, humanTeam: r.humanTeam });
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
      this.verified = this.replay.fp ? finalHash(w) === this.replay.fp : null;
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
  w.uvar(t.players.length);
  for (const p of t.players) {
    w.str(p.id);
    w.str(p.name);
    w.uvar(p.number);
    w.byte(ROLES.indexOf(p.role));
    for (const k of ATTRS) w.num(p.attrs[k]);
  }
}

function readTeam(r: Reader): TeamSetup {
  const name = r.str();
  const short = r.str();
  const primary = readColour(r);
  const secondary = readColour(r);
  const aiSkill = r.num();
  const count = r.uvar();
  if (count !== TEAM_SIZE) throw new Error('Replay code has the wrong squad size.');
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
  return { name, short, primary, secondary, players, aiSkill };
}

// Run flags. A tick that only moves the pointer is one flag byte plus two
// small deltas; a repeat count is only written when the run is longer than 1.
const F_CURSOR = 1;
const F_DIR = 2;
const F_PASS = 4;
const F_SPRINT = 8;
const F_SWITCH = 16;
/** An extra byte follows with the rarer fields. */
const F_EXT = 32;
/** The run is longer than one tick; its length follows. */
const F_MULTI = 64;
const E_THROUGH = 1;
const E_CHIP = 2;
/** The shot power byte follows the extra byte. */
const E_SHOOT = 4;

function writeRuns(w: Writer, runs: InputRun[]) {
  // Cursor and axes are delta-coded against the previous run's, in whole cm.
  let cx = 0;
  let cy = 0;
  let dx = 0;
  let dy = 0;
  for (const { n, input: i } of runs) {
    let e = 0;
    if (i.through) e |= E_THROUGH;
    if (i.chip) e |= E_CHIP;
    if (i.shoot !== undefined) e |= E_SHOOT;
    let f = 0;
    if (i.cursor) f |= F_CURSOR;
    if (i.dir) f |= F_DIR;
    if (i.pass) f |= F_PASS;
    if (i.sprint) f |= F_SPRINT;
    if (i.switchPlayer) f |= F_SWITCH;
    if (e) f |= F_EXT;
    if (n > 1) f |= F_MULTI;
    w.byte(f);
    if (e) w.byte(e);
    if (i.shoot !== undefined) w.byte(Math.round(i.shoot * 100));
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
    if (n > 1) w.uvar(n);
  }
}

function readRuns(r: Reader, ticks: number): InputRun[] {
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
    if (f & F_PASS) input.pass = true;
    if (f & F_SPRINT) input.sprint = true;
    if (e & E_THROUGH) input.through = true;
    if (e & E_CHIP) input.chip = true;
    if (f & F_SWITCH) input.switchPlayer = true;
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

export function encodeReplay(r: Replay): string {
  const w = new Writer();
  w.byte(1);
  w.ivar(r.seed | 0);
  w.uvar(Math.round(r.halfSeconds * 1000));
  w.byte(r.humanTeam + 1);
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
  writeRuns(w, r.runs);
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
  if (r.byte() !== 1) throw new Error('Replay code is from a newer version of the game.');
  const seed = r.ivar() | 0;
  const halfSeconds = r.uvar() / 1000;
  const humanTeam = (r.byte() - 1) as 0 | 1 | -1;
  if (halfSeconds < 1 || halfSeconds > 3600 || ![-1, 0, 1].includes(humanTeam)) throw new Error('Replay code is damaged or cut short.');
  const home = readTeam(r);
  const away = readTeam(r);
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
  const runs = readRuns(r, ticks);
  if (!r.done) throw new Error('Replay code is damaged or cut short.');
  return { seed, halfSeconds, humanTeam, home, away, ticks, runs, goals, score, fp, label, at };
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
/** Total characters of the stored JSON. */
export const KEEP_CHARS = 300_000;

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
