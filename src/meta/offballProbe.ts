// Off-ball play, measured from a headless match. Pure (no DOM).
// scripts/offball-probe.ts prints it.
//
// Two questions:
//  1. Shape. Does each formation hold its shape with and without the ball?
//     Each outfielder's position is taken relative to his side's outfield
//     centroid and compared with his slot in the template (FORMATIONS),
//     after a best-fit stretch on each axis. The block may compress or
//     widen as a whole; the residual is what's left over, in metres, when a
//     player is out of his place in the shape.
//  2. Options. When the human has the ball, how many teammates are on for a
//     pass? Counted every sample while a carrier is on the ball. A teammate
//     is open when he is 5 to 35 m away, no opponent is within 1.5 m (plus
//     3% of the distance) of the straight lane from 1.5 m out, and none is
//     within 2.5 m of him. The human here is a scripted bot (humanBot below) that runs at
//     goal and passes to the most forward open teammate.
//
// All in metres in each side's own frame (x from its own goal line; y is world y, as
// slots are).

import { PITCH_H, PITCH_W, TICK_HZ, type FormationSlot, type Role } from '../sim/constants.ts';
import { oppGoal, secondLastOpponentX, slotOf, teamX } from '../sim/field.ts';
import { createMatch, step, type MatchOptions } from '../sim/match.ts';
import type { HumanInput, MatchPlayer, MatchState } from '../sim/types.ts';

const tx = teamX;
const goalOf = oppGoal;

const LINES: Role[] = ['DEF', 'MID', 'FWD'];

export interface ShapePhase {
  samples: number;
  /** Best-fit stretch of the template, length (x) and width (y). 1 = the template's own size. */
  stretchX: number;
  stretchY: number;
  /** Residual of the average positions against the stretched template, RMS over slots (m). */
  meanErr: number;
  /** The same per sample, then averaged: how far players are from their place moment to moment (m). */
  instErr: number;
  /** Average height of each line (DEF, MID, FWD) from own goal (m). */
  lineX: number[];
  /** Average front-to-back spread inside each line (m): a flat line is small. */
  lineSpread: number[];
  /** Share of samples where a line is not ahead of the line behind it by 3 m (lines merged or crossed). */
  merged: number;
  /** Per slot: label, average x, y (m, own frame), and its error against the stretched template. */
  slots: { label: string; x: number; y: number; err: number }[];
  /** Label of the slot furthest from its place on average. */
  worst: string;
}

export interface OptionStats {
  /** Carrier samples taken. */
  samples: number;
  /** Seconds of carrying sampled. */
  seconds: number;
  /** Open teammates on average. */
  open: number;
  /** Share of time with 2+ open, and with none (%). */
  twoPlus: number;
  none: number;
  /** Open teammates more than 5 m ahead of the ball. */
  forward: number;
  /** Teammates on the last line or beyond it and running forward (over 2.5 m/s): runs in behind. */
  runners: number;
  /** Share of time, in the opponents' half, with a teammate within 8 m of each touchline ahead of the ball (%). */
  width: number;
  /** Open teammates within 15 m. */
  short: number;
  /** Open teammates by how long the carrier has had it: under 0.5 s, 0.5-1 s, 1-2 s, 2 s and more. */
  openByTime: number[];
  /** The carrier's average speed (m/s). */
  speed: number;
}

interface ShapeAcc {
  n: number;
  sx: number[];
  sy: number[];
  inst: number;
  lineX: number[];
  lineSpread: number[];
  lineN: number;
  merged: number;
}

interface OptAcc {
  n: number;
  open: number;
  two: number;
  none: number;
  fwd: number;
  runners: number;
  short: number;
  wideN: number;
  wide: number;
  speed: number;
  byT: number[];
  byTN: number[];
}

const newShape = (k: number): ShapeAcc => ({ n: 0, sx: Array(k).fill(0), sy: Array(k).fill(0), inst: 0, lineX: [0, 0, 0], lineSpread: [0, 0, 0], lineN: 0, merged: 0 });
const newOpt = (): OptAcc => ({ n: 0, open: 0, two: 0, none: 0, fwd: 0, runners: 0, short: 0, wideN: 0, wide: 0, speed: 0, byT: [0, 0, 0, 0], byTN: [0, 0, 0, 0] });
const TIME_BUCKETS = [0.5, 1, 2, Infinity];

/** Least-squares stretch a (per axis) of template offsets t onto measured offsets m, and the residual RMS. */
function fit(t: number[], m: number[]): { a: number; res: number[] } {
  let tm = 0;
  let tt = 0;
  for (let i = 0; i < t.length; i++) {
    tm += t[i] * m[i];
    tt += t[i] * t[i];
  }
  const a = tt > 1e-9 ? tm / tt : 1;
  return { a, res: t.map((v, i) => m[i] - a * v) };
}

const centred = (v: number[]): number[] => {
  const c = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  return v.map((x) => x - c);
};

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const l2 = abx * abx + aby * aby;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / l2));
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Is teammate m on for a pass from c? */
export function isOpen(s: MatchState, c: MatchPlayer, m: MatchPlayer): boolean {
  const dx = m.pos.x - c.pos.x;
  const dy = m.pos.y - c.pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 5 || d > 35) return false;
  const lane = 1.5 + 0.03 * d;
  // The lane starts 1.5 m out: a man tight on the carrier doesn't shut every pass (it goes round him).
  const ax = c.pos.x + (dx / d) * 1.5;
  const ay = c.pos.y + (dy / d) * 1.5;
  for (const o of s.players) {
    if (o.team === c.team || o.sentOff) continue;
    if (Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 2.5) return false;
    if (segDist(o.pos.x, o.pos.y, ax, ay, m.pos.x, m.pos.y) < lane) return false;
  }
  return true;
}

function sampleShape(s: MatchState, team: 0 | 1, slots: FormationSlot[], a: ShapeAcc): void {
  const out = s.players.filter((p) => p.team === team && p.role !== 'GK');
  if (out.length !== slots.length - 1 || out.some((p) => p.sentOff)) return;
  out.sort((p, q) => p.slot - q.slot);
  const mx = out.map((p) => tx(s, team, p.pos.x) * PITCH_W);
  // Across: slots use world y for both sides (fromTeam flips x only).
  const my = out.map((p) => p.pos.y);
  for (let i = 0; i < out.length; i++) {
    a.sx[i] += mx[i];
    a.sy[i] += my[i];
  }
  const tpl = out.map((p) => slots[p.slot]);
  const fx = fit(centred(tpl.map((f) => f.x * PITCH_W)), centred(mx));
  const fy = fit(centred(tpl.map((f) => f.y * PITCH_H)), centred(my));
  let e = 0;
  for (let i = 0; i < out.length; i++) e += fx.res[i] ** 2 + fy.res[i] ** 2;
  a.inst += Math.sqrt(e / out.length);
  const lx: number[] = [];
  for (let l = 0; l < 3; l++) {
    const xs = mx.filter((_, i) => tpl[i].role === LINES[l]);
    if (!xs.length) {
      lx.push(NaN);
      continue;
    }
    const avg = xs.reduce((p, q) => p + q, 0) / xs.length;
    lx.push(avg);
    a.lineX[l] += avg;
    a.lineSpread[l] += Math.max(...xs) - Math.min(...xs);
  }
  a.lineN++;
  if (lx[1] < lx[0] + 3 || lx[2] < lx[1] + 3) a.merged++;
  a.n++;
}

function sampleOptions(s: MatchState, c: MatchPlayer, onBall: number, a: OptAcc): void {
  const team = c.team;
  const bx = tx(s, team, s.ball.pos.x) * PITCH_W;
  const lastLine = secondLastOpponentX(s, team) * PITCH_W;
  const dirX = goalOf(s, team).x > PITCH_W / 2 ? 1 : -1;
  let open = 0;
  let fwd = 0;
  let short = 0;
  let runners = 0;
  let left = false;
  let right = false;
  for (const m of s.players) {
    if (m.team !== team || m.i === c.i || m.role === 'GK' || m.sentOff) continue;
    const x = tx(s, team, m.pos.x) * PITCH_W;
    if (isOpen(s, c, m)) {
      open++;
      if (x > bx + 5) fwd++;
      if (Math.hypot(m.pos.x - c.pos.x, m.pos.y - c.pos.y) <= 15) short++;
    }
    if (x > lastLine - 1 && m.vel.x * dirX > 2.5) runners++;
    if (x > bx) {
      if (m.pos.y < 8) left = true;
      if (m.pos.y > PITCH_H - 8) right = true;
    }
  }
  a.n++;
  a.open += open;
  a.fwd += fwd;
  a.short += short;
  a.runners += runners;
  const bucket = TIME_BUCKETS.findIndex((t) => onBall < t);
  a.byT[bucket] += open;
  a.byTN[bucket]++;
  a.speed += Math.hypot(c.vel.x, c.vel.y);
  if (open >= 2) a.two++;
  if (open === 0) a.none++;
  if (bx > PITCH_W / 2) {
    a.wideN++;
    if (left && right) a.wide++;
  }
}

/**
 * The scripted human: with the ball he runs at goal, and after 1 to 2 s on it
 * passes to the open teammate furthest forward (or shoots inside 22 m); without
 * it he chases the ball and tackles when close. He takes his side's restarts short
 * at once. Deterministic (no RNG draws).
 */
export function humanBot(s: MatchState, team: 0 | 1, held: { since: number }): HumanInput {
  const me = s.players[s.controlled[team]];
  const r = s.restart;
  if (s.phase === 'restart' && r && r.team === team && r.stage === 'ready' && r.taker === me.i) {
    // Take our restarts at once, short to the nearest teammate, as a player clicking would.
    let mate: MatchPlayer | null = null;
    for (const m of s.players) {
      if (m.team !== team || m.i === me.i || m.sentOff || m.role === 'GK') continue;
      if (!mate || Math.hypot(m.pos.x - me.pos.x, m.pos.y - me.pos.y) < Math.hypot(mate.pos.x - me.pos.x, mate.pos.y - me.pos.y)) mate = m;
    }
    return mate ? { cursor: { ...mate.pos }, aim: { ...mate.pos }, pass: true, moved: true } : {};
  }
  if (s.phase !== 'play') return {};
  const goal = goalOf(s, team);
  const b = s.ball;
  if (b.owner === me.i) {
    if (held.since < 0) held.since = s.tick;
    const t = (s.tick - held.since) / TICK_HZ;
    if (Math.hypot(goal.x - me.pos.x, goal.y - me.pos.y) < 22) return { cursor: goal, aim: goal, shoot: 0.85, moved: true };
    if (t > 1 + ((s.tick * 7) % 60) / 60) {
      let best: MatchPlayer | null = null;
      let bestX = -Infinity;
      for (const m of s.players) {
        if (m.team !== team || m.i === me.i || m.sentOff || !isOpen(s, me, m)) continue;
        const x = tx(s, team, m.pos.x);
        if (x > bestX) {
          bestX = x;
          best = m;
        }
      }
      if (best) {
        held.since = -1;
        return { cursor: best.pos, aim: best.pos, pass: true, moved: true };
      }
    }
    const ahead = { x: me.pos.x + Math.sign(goal.x - me.pos.x) * 10, y: me.pos.y + (goal.y - me.pos.y) * 0.2 };
    return { cursor: ahead, moved: true };
  }
  held.since = -1;
  const owner = b.owner >= 0 ? s.players[b.owner] : null;
  const near = Math.hypot(b.pos.x - me.pos.x, b.pos.y - me.pos.y);
  return { cursor: b.pos, tackle: !!owner && owner.team !== team && near < 2, moved: true };
}

export interface OffballResult {
  /** Per side: [in possession, out of possession]. */
  shape: [[ShapeAcc, ShapeAcc], [ShapeAcc, ShapeAcc]];
  /** Per side: options while that side's carrier (any) has the ball, and while its human does. */
  options: [OptAcc, OptAcc];
  humanOptions: OptAcc;
  state: MatchState;
}

/** Play one match, home optionally driven by humanBot, sampling every 6 ticks of open play. */
export function measureOffball(o: Omit<MatchOptions, 'humanTeam' | 'humans'>, humanHome: boolean): OffballResult {
  const s = createMatch({ ...o, humans: [humanHome, false] });
  const slots: [FormationSlot[], FormationSlot[]] = [0, 1].map((t) => s.players.filter((p) => p.team === t).sort((p, q) => p.slot - q.slot).map((p) => slotOf(s, p))) as [FormationSlot[], FormationSlot[]];
  const k = [slots[0].length - 1, slots[1].length - 1];
  const shape: OffballResult['shape'] = [
    [newShape(k[0]), newShape(k[0])],
    [newShape(k[1]), newShape(k[1])],
  ];
  const options: [OptAcc, OptAcc] = [newOpt(), newOpt()];
  const humanOptions = newOpt();
  const held = { since: -1 };
  let carrier = -1;
  let since = 0;
  while (s.phase !== 'fulltime') {
    step(s, humanHome ? [humanBot(s, 0, held), {}] : undefined);
    if (s.ball.owner !== carrier) {
      carrier = s.ball.owner;
      since = s.tick;
    }
    if (s.phase !== 'play' || s.tick % 6) continue;
    const owner = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
    const onBall = (s.tick - since) / TICK_HZ;
    if (!owner || owner.role === 'GK') continue;
    for (const team of [0, 1] as const) sampleShape(s, team, slots[team], shape[team][owner.team === team ? 0 : 1]);
    sampleOptions(s, owner, onBall, options[owner.team]);
    if (humanHome && owner.team === 0 && owner.i === s.controlled[0]) sampleOptions(s, owner, onBall, humanOptions);
  }
  return { shape, options, humanOptions, state: s };
}

/** Sum accumulators across matches (in place on the first). */
export function addShape(a: ShapeAcc, b: ShapeAcc): ShapeAcc {
  a.n += b.n;
  a.inst += b.inst;
  a.lineN += b.lineN;
  a.merged += b.merged;
  for (let i = 0; i < a.sx.length; i++) {
    a.sx[i] += b.sx[i];
    a.sy[i] += b.sy[i];
  }
  for (let l = 0; l < 3; l++) {
    a.lineX[l] += b.lineX[l];
    a.lineSpread[l] += b.lineSpread[l];
  }
  return a;
}

export function addOpt(a: OptAcc, b: OptAcc): OptAcc {
  for (const key of Object.keys(a) as (keyof OptAcc)[]) {
    const v = a[key];
    if (typeof v === 'number') (a[key] as number) = v + (b[key] as number);
  }
  for (let i = 0; i < a.byT.length; i++) {
    a.byT[i] += b.byT[i];
    a.byTN[i] += b.byTN[i];
  }
  return a;
}

export function shapeSummary(a: ShapeAcc, slots: FormationSlot[]): ShapePhase {
  const out = slots.filter((f) => f.role !== 'GK');
  const n = Math.max(1, a.n);
  const mx = a.sx.map((v) => v / n);
  const my = a.sy.map((v) => v / n);
  const fx = fit(centred(out.map((f) => f.x * PITCH_W)), centred(mx));
  const fy = fit(centred(out.map((f) => f.y * PITCH_H)), centred(my));
  const err = out.map((_, i) => Math.hypot(fx.res[i], fy.res[i]));
  const worstI = err.indexOf(Math.max(...err));
  const ln = Math.max(1, a.lineN);
  return {
    samples: a.n,
    stretchX: fx.a,
    stretchY: fy.a,
    meanErr: Math.sqrt(err.reduce((p, e) => p + e * e, 0) / Math.max(1, err.length)),
    instErr: a.inst / n,
    lineX: a.lineX.map((v) => v / ln),
    lineSpread: a.lineSpread.map((v) => v / ln),
    merged: (100 * a.merged) / ln,
    slots: out.map((f, i) => ({ label: f.label, x: mx[i], y: my[i], err: err[i] })),
    worst: out[worstI]?.label ?? '',
  };
}

export function optionSummary(a: OptAcc): OptionStats {
  const n = Math.max(1, a.n);
  return {
    samples: a.n,
    seconds: (a.n * 6) / TICK_HZ,
    open: a.open / n,
    twoPlus: (100 * a.two) / n,
    none: (100 * a.none) / n,
    forward: a.fwd / n,
    runners: a.runners / n,
    width: a.wideN ? (100 * a.wide) / a.wideN : 0,
    short: a.short / n,
    openByTime: a.byT.map((v, i) => (a.byTN[i] ? v / a.byTN[i] : 0)),
    speed: a.speed / n,
  };
}
