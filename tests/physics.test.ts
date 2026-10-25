// Passing, ball physics, goalkeeping and keeper control: the owner's feedback of 2026-10-24
// (asks 2-6, 8 and 11) as tests. Input timing lives in src/client/input.ts (pure parts tested
// here), what the sim does with it in src/sim/human.ts, kicks.ts and match.ts.

import { describe, expect, test } from 'bun:test';
import { CLICK_MS, leftRelease, loftPower, OneEuro, TOUCH_CLICK_MS } from '../src/client/input.ts';
import { kickGauge, PASS_FULL } from '../src/client/power.ts';
import { longView } from '../src/client/r3d/renderer3d.ts';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { decodeReplay, encodeReplay, finalHash, quantiseInput, replayTo, ReplayRecorder } from '../src/meta/replay.ts';
import { GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W, RESTART_HUMAN_WAIT } from '../src/sim/constants.ts';
import { goalkeeper } from '../src/sim/field.ts';
import { keeperControllable } from '../src/sim/human.ts';
import { assistRadius, groundPassPlan, pointerPass, PUNT_MIN_RANGE, receiverArrival, rollDistance } from '../src/sim/kicks.ts';
import { createMatch, fingerprint, KEEPER_HOLD_TICKS, possessionShare, step } from '../src/sim/match.ts';
import { awardRestart } from '../src/sim/rules.ts';
import { next } from '../src/sim/rng.ts';
import type { HumanInput, MatchPlayer, MatchState } from '../src/sim/types.ts';
import { dist, len, type Vec } from '../src/sim/vec.ts';
import { openPlay } from './helpers.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

function livePlay(seed = 5, humanTeam: 0 | 1 | -1 = 0): MatchState {
  const s = createMatch({ seed, ...teams(7), halfSeconds: 60, humanTeam });
  openPlay(s);
  return s;
}

/** Everyone but `keep` is out of it: far away and on the floor. */
function isolate(s: MatchState, ...keep: MatchPlayer[]): void {
  for (const p of s.players) {
    if (keep.includes(p)) continue;
    p.stun = 100000;
    p.pos = { x: 52 + (p.i % 5), y: -2 - (p.i % 3) };
    p.vel = { x: 0, y: 0 };
  }
}

const mid = (s: MatchState, team: 0 | 1, k = 0) => s.players.filter((p) => p.team === team && p.role === 'MID')[k];

/** The human has the ball at `at`, one teammate `mate` is free at `mateAt`, nobody else around. */
function passScene(at: Vec, mateAt: Vec) {
  const s = livePlay();
  const me = s.players[s.controlled[0]];
  const mate = s.players.find((p) => p.team === 0 && p.role === 'MID' && p.i !== me.i)!;
  isolate(s, me, mate);
  s.switchTimer[0] = 1e9;
  me.pos = { ...at };
  me.vel = { x: 0, y: 0 };
  me.facing = { x: 1, y: 0 };
  mate.pos = { ...mateAt };
  mate.vel = { x: 0, y: 0 };
  s.ball.owner = me.i;
  s.ball.pos = { x: at.x + 0.99, y: at.y };
  s.ball.vel = { x: 0, y: 0 };
  return { s, me, mate };
}

// ---------------------------------------------------------------------------
// Ask 2: a click is a ground pass

describe('a click is always a ground pass (ask 2)', () => {
  test('diagnosis: the old 200 ms threshold turned slow clicks into lofts; now any press under 300 ms is a click', () => {
    // Realistic click durations, mouse 60-260 ms (trackpad taps run long), every one a pass.
    for (let ms = 60; ms <= 260; ms += 5) expect(leftRelease(ms)).toEqual({ pass: true });
    expect(CLICK_MS).toBe(300);
    // Touch and pen taps are slower still.
    for (let ms = 60; ms <= 340; ms += 10) expect(leftRelease(ms, 'touch')).toEqual({ pass: true });
    expect(TOUCH_CLICK_MS).toBeGreaterThan(CLICK_MS);
    // A deliberate hold lofts, flattest at the threshold, full at 900 ms.
    expect(leftRelease(CLICK_MS)).toEqual({ loft: 0 });
    expect(loftPower(900)).toBe(1);
    expect(loftPower(600)).toBeCloseTo(0.5, 5);
  });

  test('100% ground passes from 200 seeded clicks of 60-260 ms through the sim: the ball never leaves the floor', () => {
    let ground = 0;
    let kicks = 0;
    let seed = 12345;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 200; i++) {
      const ms = 60 + 200 * rand();
      const angle = rand() * Math.PI * 2;
      const len = 6 + 24 * rand();
      const { s, me } = passScene({ x: 40, y: 34 }, { x: 90, y: 60 });
      const aim = { x: 40 + Math.cos(angle) * len, y: 34 + Math.sin(angle) * len * 0.8 };
      const r = leftRelease(ms);
      const input: HumanInput = { cursor: aim, aim, ...('pass' in r ? { pass: true } : { loft: r.loft }) };
      step(s, input);
      if (s.ball.owner === me.i) continue;
      kicks++;
      let maxZ = 0;
      for (let t = 0; t < 40; t++) {
        maxZ = Math.max(maxZ, s.ball.z);
        step(s, { cursor: aim });
      }
      if (maxZ === 0) ground++;
    }
    expect(kicks).toBe(200);
    expect(ground).toBe(200);
  });

  test('a click aims where the button went down: the sim kicks to `aim`, not the cursor', () => {
    const { s, mate } = passScene({ x: 30, y: 30 }, { x: 42, y: 30 });
    step(s, { cursor: { x: 30, y: 50 }, aim: { x: 42, y: 30 }, pass: true });
    expect(s.ball.receiver).toBe(mate.i);
  });
});

describe('pointer smoothing (ask 11)', () => {
  test('One Euro: a still pointer stays put, a jittery one is calmed, a fast sweep lags little', () => {
    const f = new OneEuro();
    let out: Vec = { x: 0, y: 0 };
    for (let i = 0; i < 60; i++) out = f.filter({ x: 10, y: 10 }, 1 / 60);
    expect(out.x).toBeCloseTo(10, 6);
    // Jitter of +-0.2 m around a still point: the output moves far less.
    const j = new OneEuro();
    let spread = 0;
    for (let i = 0; i < 120; i++) {
      const o = j.filter({ x: 10 + (i % 2 ? 0.2 : -0.2), y: 10 }, 1 / 60);
      if (i > 30) spread = Math.max(spread, Math.abs(o.x - 10));
    }
    expect(spread).toBeLessThan(0.1);
    // A 30 m/s sweep: within about 1.5 m of the pointer (50 ms of lag at most).
    const g = new OneEuro();
    let lag = 0;
    for (let i = 0; i < 60; i++) {
      const x = (30 * i) / 60;
      const o = g.filter({ x, y: 0 }, 1 / 60);
      if (i > 20) lag = Math.max(lag, x - o.x);
    }
    expect(lag).toBeLessThan(1.5);
  });
});

// ---------------------------------------------------------------------------
// Ask 3: weighted to reach the teammate quickly

describe('a click pass is firm and arrives quickly at a controllable pace (ask 3)', () => {
  test('to a teammate 5-25 m away: leaves at 9-20 m/s, arrives at 7-12 m/s, in under 1.7 s', () => {
    for (const d of [5, 8, 10, 15, 20, 25]) {
      const arrive = receiverArrival(d);
      const plan = groundPassPlan(d, arrive);
      expect(arrive).toBeGreaterThanOrEqual(7);
      expect(arrive).toBeLessThanOrEqual(12);
      expect(plan.speed).toBeGreaterThan(8.5);
      expect(plan.speed).toBeLessThan(21);
      expect(plan.flight).toBeLessThan(1.7);
      expect(rollDistance(plan.speed, arrive)).toBeCloseTo(d, 1);
      // Short passes (10 m) in under a second: research says about 0.4-0.8 s.
      if (d <= 10) expect(plan.flight).toBeLessThan(0.95);
    }
  });

  test('in the sim: clicked on a teammate 6-22 m away, the ball reaches him fast and he controls it every time', () => {
    // In our own half: the parked opponents would leave anyone beyond halfway offside.
    for (const [dx, dy] of [[6, 0], [10, 3], [14, -5], [18, 6], [22, 0], [-9, 7], [3, -12]]) {
      const { s, me, mate } = passScene({ x: 25, y: 34 }, { x: 25 + dx, y: 34 + dy });
      step(s, { cursor: mate.pos, aim: mate.pos, pass: true });
      expect(s.ball.receiver).toBe(mate.i);
      const kickSpeed = len(s.ball.vel);
      expect(kickSpeed).toBeGreaterThan(8.5);
      let t = 0;
      let arrival = 0;
      while (s.ball.owner !== mate.i && t < 180) {
        arrival = len(s.ball.vel);
        step(s, { cursor: mate.pos });
        t++;
      }
      expect(s.ball.owner).toBe(mate.i);
      const d = Math.hypot(dx, dy);
      expect(t / 60).toBeLessThan(0.3 + d / 9);
      expect(arrival).toBeGreaterThan(5.5);
      void me;
    }
  });

  test('the power cone shows the pace the click will really be kicked at', () => {
    const { s, me, mate } = passScene({ x: 30, y: 30 }, { x: 45, y: 30 });
    for (const aim of [mate.pos, { x: 40, y: 45 }]) {
      const g = kickGauge(s, { cursor: aim, charge: 0, showCursor: true })!;
      expect(g.fill).toBeCloseTo(pointerPass(s, me, aim).speed / PASS_FULL, 6);
    }
  });

  test('the assist: near a teammate (distance-scaled radius) or on the line to him (12 degree cone) it goes to his feet; empty grass goes to the point', () => {
    const { s, me, mate } = passScene({ x: 30, y: 30 }, { x: 50, y: 30 });
    expect(assistRadius(5)).toBeCloseTo(2, 5);
    expect(assistRadius(20)).toBeCloseTo(3.5, 5);
    expect(assistRadius(60)).toBe(4);
    // 3 m to the side of him at 20 m: inside the radius.
    expect(pointerPass(s, me, { x: 50, y: 33 }).receiver).toBe(mate.i);
    // Just short of him on the line (camera depth error): inside the cone.
    expect(pointerPass(s, me, { x: 45, y: 31 }).receiver).toBe(mate.i);
    // Far beyond him on the same line: a ball into space, to the point.
    const far = pointerPass(s, me, { x: 70, y: 30 });
    expect(far.receiver).toBe(-1);
    expect(far.target).toEqual({ x: 70, y: 30 });
    // Off to the side, empty grass.
    const side = pointerPass(s, me, { x: 40, y: 45 });
    expect(side.receiver).toBe(-1);
    expect(side.target).toEqual({ x: 40, y: 45 });
    // Into space the ball slows to a stop near the point; to a teammate it arrives firmly.
    expect(far.speed).toBeLessThan(groundPassPlan(40, receiverArrival(40)).speed);
  });

  test('a runner is led: the ball goes to where he will be', () => {
    const { s, me, mate } = passScene({ x: 30, y: 30 }, { x: 40, y: 22 });
    mate.vel = { x: 6, y: 0 };
    const r = pointerPass(s, me, { x: 40.5, y: 22.5 });
    expect(r.receiver).toBe(mate.i);
    expect(r.target.x).toBeGreaterThan(44);
  });

  test('the receiver steps up to meet the ball, whatever the pointer is doing', () => {
    const { s, mate } = passScene({ x: 30, y: 30 }, { x: 48, y: 30 });
    step(s, { cursor: mate.pos, aim: mate.pos, pass: true });
    step(s, { cursor: mate.pos });
    expect(s.controlled[0]).toBe(mate.i);
    const start = { ...mate.pos };
    // Pointer far behind him (stale): he still goes toward the ball, not toward the pointer.
    for (let t = 0; t < 20 && s.ball.owner < 0; t++) step(s, { cursor: { x: 70, y: 30 }, moved: true });
    expect(mate.pos.x).toBeLessThan(start.x);
  });
});

// ---------------------------------------------------------------------------
// Ask 6: tiki-taka

describe('quick click passes chain (ask 6)', () => {
  test('after receiving, a receiver whose pointer has not moved holds still: no running back to the stale pointer', () => {
    const { s, mate } = passScene({ x: 30, y: 30 }, { x: 44, y: 30 });
    const stale = { x: 44, y: 30 };
    step(s, { cursor: stale, aim: stale, pass: true });
    // He meets the ball (moving toward the passer), so the pointer ends up behind him.
    let t = 0;
    while (s.ball.owner !== mate.i && t++ < 120) step(s, { cursor: stale });
    expect(s.ball.owner).toBe(mate.i);
    const got = { ...mate.pos };
    for (let k = 0; k < 30; k++) step(s, { cursor: stale });
    expect(dist(mate.pos, got)).toBeLessThan(0.6);
    // Move the pointer and he goes: a turn with the ball, then the run (0.6 s; at 0.5 s how far he
    // has got depends on a few centimetres of where he met the pass).
    for (let k = 0; k < 36; k++) step(s, { cursor: { x: 60, y: 30 }, moved: true });
    expect(mate.pos.x).toBeGreaterThan(got.x + 2);
  });

  test('a resting hand that nudges the mouse now and then does not send him back to the stale pointer', () => {
    const { s, mate } = passScene({ x: 30, y: 30 }, { x: 44, y: 30 });
    const stale = { x: 30, y: 44 }; // well off to one side
    step(s, { cursor: mate.pos, aim: mate.pos, pass: true });
    let t = 0;
    while (s.ball.owner !== mate.i && t++ < 120) step(s, { cursor: stale });
    const got = { ...mate.pos };
    // Two seconds with a one-tick nudge every 25 ticks (about 4% of ticks).
    for (let k = 0; k < 120; k++) step(s, { cursor: stale, moved: k % 25 === 0 });
    expect(dist(mate.pos, got)).toBeLessThan(0.6);
  });

  test('a click made while the pass is still coming is played first time the moment he has it', () => {
    const s = livePlay();
    const me = s.players[s.controlled[0]];
    const a = mid(s, 0, 0).i === me.i ? mid(s, 0, 1) : mid(s, 0, 0);
    const c = s.players.find((p) => p.team === 0 && p.role === 'DEF')!;
    isolate(s, me, a, c);
    s.switchTimer[0] = 1e9;
    me.pos = { x: 30, y: 30 };
    a.pos = { x: 42, y: 30 };
    c.pos = { x: 42, y: 42 };
    for (const p of [me, a, c]) p.vel = { x: 0, y: 0 };
    s.ball.owner = me.i;
    s.ball.pos = { x: 31, y: 30 };
    step(s, { cursor: a.pos, aim: a.pos, pass: true });
    step(s, { cursor: c.pos, aim: c.pos, select: true, moved: true });
    let t = 0;
    while (s.ball.owner !== a.i && t++ < 120) step(s, { cursor: c.pos });
    // He has it: next tick it is on its way to c.
    step(s, { cursor: c.pos });
    expect(s.ball.owner).toBe(-1);
    expect(s.ball.receiver).toBe(c.i);
    expect(s.ball.lastTouch).toBe(a.i);
  });

  test('a scripted human playing short click passes to the nearest open teammate completes most of them', () => {
    // Report numbers for the PR: completion and passes per possession.
    let att = 0;
    let comp = 0;
    let poss = 0;
    let passes = 0;
    for (let m = 0; m < 3; m++) {
      const s = createMatch({ seed: 40 + m, ...teams(11 + m), halfSeconds: 45, humanTeam: 0 });
      s.teams[1].aiSkill = 0.6;
      let wait = 0;
      let pending: { tick: number } | null = null;
      let cursor: Vec = { x: 50, y: 34 };
      let last = -1;
      while (s.phase !== 'fulltime') {
        const me = s.players[s.controlled[0]];
        const b = s.ball;
        const input: HumanInput = { cursor };
        // The kick-off is a real kick (Law 8): the script plays it like any other pass.
        const kickoff = s.phase === 'restart' && s.restart?.kind === 'kickoff' && s.restart.stage === 'ready';
        if ((s.phase === 'play' || kickoff) && b.owner === me.i && me.role !== 'GK') {
          if (wait === 0) wait = 12;
          if (--wait === 0) {
            const open = s.players
              .filter((t) => t.team === 0 && t.i !== me.i && t.role !== 'GK' && !t.sentOff && dist(t.pos, me.pos) > 5 && dist(t.pos, me.pos) < 22)
              .filter((t) => !s.players.some((o) => o.team === 1 && !o.sentOff && dist(o.pos, t.pos) < 3))
              .sort((x, y) => dist(x.pos, me.pos) - dist(y.pos, me.pos))[0];
            if (open) {
              cursor = { ...open.pos };
              Object.assign(input, { cursor, aim: cursor, pass: true, moved: true });
              pending = { tick: s.tick };
            } else wait = 6;
          }
        } else if (s.phase === 'play' && b.owner >= 0 && s.players[b.owner].team === 1) {
          cursor = { ...b.pos };
          Object.assign(input, { cursor, moved: true });
        }
        step(s, input);
        if (pending && s.tick === pending.tick + 1) att++;
        if (pending && s.tick > pending.tick + 1 && (s.phase !== 'play' || s.ball.owner >= 0)) {
          if (s.phase === 'play' && s.players[s.ball.owner].team === 0) comp++;
          pending = null;
        }
        if (s.ball.owner >= 0) {
          const tm = s.players[s.ball.owner].team;
          if (tm === 0 && last !== 0) poss++;
          last = tm;
        }
      }
      passes += s.stats[0].passes;
    }
    const completion = comp / att;
    console.log(`scripted tiki-taka: ${att} click passes, ${(completion * 100).toFixed(0)}% completed, ${(passes / poss).toFixed(2)} passes per possession`);
    expect(att).toBeGreaterThan(60);
    expect(completion).toBeGreaterThan(0.65);
    expect(passes / poss).toBeGreaterThan(1.5);
  });
});

// ---------------------------------------------------------------------------
// Ask 4: ball collisions by height

/** A loose ball fired from `from` with velocity `vel` at height z, vz; everyone but `keep` out of it. */
function fire(s: MatchState, from: Vec, vel: Vec, z = 0, vz = 0) {
  const b = s.ball;
  b.owner = -1;
  b.receiver = -1;
  b.passFrom = -1;
  b.inHands = false;
  b.pos = { ...from };
  b.vel = { ...vel };
  b.z = z;
  b.vz = vz;
  b.kickedBy = -1;
  b.lastTouch = -1;
  b.touch = 0;
  b.noPickup.fill(0);
}

describe('the ball meets bodies by height (ask 4)', () => {
  function oneOpponent(at: Vec) {
    const s = livePlay(9, -1);
    const o = mid(s, 1);
    isolate(s, o);
    o.pos = { ...at };
    o.vel = { x: 0, y: 0 };
    o.stun = 0;
    o.attrs.dribbling = 0;
    return { s, o };
  }

  test('a hard ground ball straight at a player bounces off him: it never passes through', () => {
    for (let k = 0; k < 10; k++) {
      const { s, o } = oneOpponent({ x: 50, y: 30 + k * 0.03 });
      fire(s, { x: 40, y: 30 }, { x: 26, y: 0 });
      let passed = false;
      for (let t = 0; t < 40; t++) {
        step(s);
        if (s.ball.owner < 0 && s.ball.pos.x > o.pos.x + 1) passed = true;
      }
      expect(passed).toBe(false);
    }
  });

  test('a ball at waist height is taken on the thigh or chest when soft, and drops to the feet', () => {
    const { s, o } = oneOpponent({ x: 50, y: 30 });
    o.attrs.dribbling = 0.8;
    fire(s, { x: 46, y: 30 }, { x: 8, y: 0 }, 1.1, 0);
    let t = 0;
    while (s.ball.owner < 0 && t++ < 40) step(s);
    expect(s.ball.owner).toBe(o.i);
    expect(s.ball.z).toBeGreaterThan(0.5); // still up as he takes it
    for (let k = 0; k < 15; k++) step(s);
    expect(s.ball.z).toBe(0);
  });

  test('a ball over head height flies over everyone; at head height an opponent heads it away', () => {
    const over = oneOpponent({ x: 50, y: 30 });
    fire(over.s, { x: 44, y: 30 }, { x: 14, y: 0 }, 4, 2);
    for (let t = 0; t < 45; t++) step(over.s);
    expect(over.s.ball.lastTouch).toBe(-1);
    expect(over.s.ball.pos.x).toBeGreaterThan(52);
    // At head height (and the jump connects in most seeds), the defender heads it.
    let headed = 0;
    for (let seed = 0; seed < 12; seed++) {
      const h = oneOpponent({ x: 50, y: 30 });
      h.s.rng.s = seed * 7919 + 1;
      h.o.attrs.defending = 0.9;
      fire(h.s, { x: 46, y: 30 }, { x: 12, y: 0 }, 2.0, -0.5);
      // The last touch is team 0's, so team 1 clears it.
      h.s.ball.lastTouch = h.s.players.find((p) => p.team === 0 && p.role === 'FWD')!.i;
      for (let t = 0; t < 30 && h.s.ball.lastTouch !== h.o.i; t++) step(h.s);
      if (h.s.ball.lastTouch === h.o.i && h.s.ball.vz > 0) headed++;
    }
    expect(headed).toBeGreaterThan(6);
  });

  test('a missed header does not let the ball through him: no ball below body height passes through a standing player', () => {
    let through = 0;
    let n = 0;
    for (let seed = 0; seed < 60; seed++)
      for (const z of [0.3, 1.0, 1.6, 1.75]) {
        const { s, o } = oneOpponent({ x: 50, y: 30 });
        s.rng.s = seed * 7919 + 13;
        o.attrs.defending = 0.1; // misses most headers
        o.attrs.dribbling = 0;
        fire(s, { x: 44, y: 30 + (seed % 5) * 0.06 }, { x: 22, y: 0 }, z, 0.4);
        s.ball.lastTouch = s.players.find((p) => p.team === 0 && p.role === 'FWD')!.i;
        let touched = false;
        for (let t = 0; t < 40 && s.phase === 'play'; t++) {
          step(s);
          if (s.ball.lastTouch === o.i) touched = true;
        }
        n++;
        if (!touched && s.ball.pos.x > o.pos.x + 1) through++;
      }
    expect(n).toBe(240);
    expect(through).toBe(0);
  });

  test('no teleporting: a loose ball never moves further in a tick than its speed allows', () => {
    const s = livePlay(3, -1);
    let worst = 0;
    for (let t = 0; t < 3600 && s.phase !== 'fulltime'; t++) {
      const before = { ...s.ball.pos };
      const v = len(s.ball.vel);
      const loose = s.ball.owner < 0 && s.phase === 'play';
      step(s);
      if (loose && s.ball.owner < 0 && s.phase === 'play') worst = Math.max(worst, dist(before, s.ball.pos) - (v / 60 + 0.6));
    }
    // Bodies push the ball out of themselves (at most a body width), but it never jumps.
    expect(worst).toBeLessThan(0.05);
  });

  test('a deflection is repeatable: the same contact twice gives the same result', () => {
    const run = () => {
      const { s } = oneOpponent({ x: 50, y: 30 });
      fire(s, { x: 40, y: 30.2 }, { x: 24, y: 0.4 });
      for (let t = 0; t < 30; t++) step(s);
      return fingerprint(s);
    };
    expect(run()).toBe(run());
  });
});

// ---------------------------------------------------------------------------
// Ask 5: goalkeeping

describe('goalkeeping (ask 5)', () => {
  /** A shot at team 1's goal (x = PITCH_W) from 20 m out, keeper set in the middle. */
  function shot(yAim: number, speed: number, z = 0, vz = 0, gkSkill = 0.75, dist = 20, fromY = PITCH_H / 2, burn = 0) {
    const s = livePlay(4, -1);
    // Advance the random stream: the same scene with different luck.
    for (let k = 0; k < burn; k++) next(s.rng);
    const gk = goalkeeper(s, 1);
    const shooter = s.players.find((p) => p.team === 0 && p.role === 'FWD')!;
    isolate(s, gk, shooter);
    gk.stun = 0;
    gk.pos = { x: PITCH_W - 1, y: PITCH_H / 2 };
    gk.vel = { x: 0, y: 0 };
    gk.attrs.goalkeeping = gkSkill;
    shooter.pos = { x: PITCH_W - dist - 1, y: fromY };
    shooter.stun = 0;
    const from = { x: PITCH_W - dist, y: fromY };
    const d = Math.hypot(dist, yAim - fromY);
    fire(s, from, { x: (speed * dist) / d, y: (speed * (yAim - fromY)) / d }, z, vz);
    s.ball.kickedBy = shooter.i;
    s.ball.lastTouch = shooter.i;
    s.ball.noPickup[shooter.i] = 30;
    shooter.kickCd = 18;
    shooter.stun = 100000; // he has struck it; he takes no further part
    const goals = s.score[0];
    let dived = false;
    let touched = false;
    // Until the keeper has touched it (or it is dead): a rebound is another story.
    let diveEndedEarly = false;
    for (let t = 0; t < 150 && s.phase === 'play' && !touched; t++) {
      const wasDiving = !!gk.dive && gk.dive.ticks > 0;
      step(s);
      if (gk.dive && gk.dive.ticks > 0) dived = true;
      if (s.ball.lastTouch === gk.i) touched = true;
      // The dive is over and he is back on his feet with the ball still on its way to him.
      if (wasDiving && !gk.dive && s.ball.pos.x < gk.pos.x - 0.5) diveEndedEarly = true;
    }
    // A parry: follow it a second longer, nobody else involved, to see it does not go in.
    for (let t = 0; t < 60 && s.phase === 'play' && touched && s.ball.owner < 0; t++) step(s);
    return { s, gk, goal: s.score[0] > goals, dived, touched, caught: s.ball.owner === gk.i, scorer: s.goals[s.goals.length - 1], diveEndedEarly };
  }

  test('a firm shot at the keeper is caught; a soft one along the floor is gathered', () => {
    expect(shot(PITCH_H / 2, 16).caught).toBe(true);
    expect(shot(PITCH_H / 2 + 0.3, 9).caught).toBe(true);
  });

  test('no ghosting: a hard shot straight at him never goes through him into the goal', () => {
    for (const sp of [20, 26, 32]) for (const z of [0, 0.8, 1.6]) expect(shot(PITCH_H / 2, sp, z, 0).goal).toBe(false);
  });

  test('a shot wide of him that he can reach: he dives across its path and usually gets a hand to it', () => {
    let saved = 0;
    const offs = [1.5, 1.8, 2.0, 2.2, 2.4, -1.6, -1.9, -2.1, -2.3, -2.5];
    for (const off of offs) {
      const r = shot(PITCH_H / 2 + off, 22);
      expect(r.dived).toBe(true);
      if (r.touched && !r.goal) saved++;
    }
    // He misreads one now and then (seeded): a good keeper saves most of them.
    expect(saved).toBeGreaterThanOrEqual(6);
  });

  test('save rates follow goalkeeping: uniformly placed shots on target from 12-25 m', () => {
    const rate = (skill: number) => {
      let saves = 0;
      const n = 40;
      for (let k = 0; k < n; k++) {
        const y = PITCH_H / 2 + (((k * 37) % 40) / 40 - 0.5) * 6.6;
        const r = shot(y, 20 + ((k * 13) % 11), 0, 0, skill);
        if (!r.goal) saves++;
      }
      return saves / n;
    };
    const weak = rate(0.3);
    const strong = rate(0.9);
    console.log(`save rate: keeper 0.3 ${(weak * 100).toFixed(0)}%, keeper 0.9 ${(strong * 100).toFixed(0)}%`);
    // Quality matters a lot: a weak keeper is beaten often, a top one rarely.
    expect(strong).toBeGreaterThan(weak + 0.2);
    expect(weak).toBeGreaterThan(0.2);
    expect(weak).toBeLessThan(0.75);
  });

  test('a fierce shot into the top corner beats him', () => {
    // About 2.2 m up as it crosses the line, 0.25 m inside the post.
    const r = shot(GOAL_TOP + 0.25, 30, 0.3, 6.2, 0.4);
    expect(r.goal).toBe(true);
  });

  test('a parry never sends the ball between the posts below the bar: palmed out, round the post or over the bar, whatever the luck', () => {
    // Twenty draws of the random stream before each shot: on one fixed seed a parry never went in,
    // but with the stream advanced 5 of about 1100 did (a tip round the post aimed before the ball
    // was moved clear of his hand, so it crossed just inside the post).
    let parried = 0;
    let goals = 0;
    for (let burn = 0; burn < 20; burn++)
      for (const skill of [0.3, 0.6, 0.9])
        for (const off of [1.2, 1.6, 1.8, 2.0, 2.2, 2.5, 3.0, -1.4, -1.7, -2.0, -2.3, -2.9])
          for (const [z, vz] of [[0, 0], [0.2, 3], [0.2, 4.5]]) {
            const r = shot(PITCH_H / 2 + off, 24, z, vz, skill, 20, PITCH_H / 2, burn);
            if (!r.touched || r.caught) continue;
            parried++;
            if (r.goal) goals++;
          }
    expect(goals).toBe(0);
    expect(parried).toBeGreaterThan(400);
  }, 30_000);

  test('timing: he dives late, landing as the ball arrives: he is never down and out of it when a reachable shot passes', () => {
    let untouched = 0;
    let n = 0;
    for (const dist of [16, 20, 25])
      for (const off of [0.9, 1.4, 1.9, -1.1, -1.6])
        for (const [sp, z, vz] of [[14, 0.2, 4], [17, 0.2, 3.5], [16, 0, 0], [20, 0, 0]]) {
          const r = shot(PITCH_H / 2 + off, sp, z, vz, 0.9, dist);
          n++;
          if (r.goal && !r.touched) untouched++;
          // When the shot goes past him, his dive (if any) is still on, or he is stretched out where his hands reach.
          if (r.dived && !r.touched) expect(r.diveEndedEarly).toBe(false);
        }
    // A 0.9 keeper still misreads one now and then (seeded), never because he went too early.
    expect(n).toBe(60);
    expect(untouched).toBeLessThanOrEqual(2);
  });

  test("a shot he parries in is the shooter's goal, not the keeper's own goal", () => {
    // Weak keeper, shots near the post: some get a hand to it and still concede.
    for (const off of [2.6, 2.9, 3.2, -2.7, -3.1])
      for (const sp of [24, 28]) {
        const r = shot(PITCH_H / 2 + off, sp, 0, 0, 0.3);
        if (r.goal) expect(r.scorer!.ownGoal).toBe(false);
      }
  });

  test('outside his box a keeper has no hands: the ball meets his feet or body like anyone else', () => {
    const s = livePlay(4, -1);
    const gk = goalkeeper(s, 1);
    isolate(s, gk);
    gk.stun = 0;
    gk.pos = { x: PITCH_W - 25, y: PITCH_H / 2 };
    fire(s, { x: PITCH_W - 35, y: PITCH_H / 2 }, { x: 12, y: 0 }, 1.6, 0);
    for (let t = 0; t < 60 && s.ball.owner < 0; t++) step(s);
    expect(s.ball.inHands).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ask 8: the human distributes from the keeper

describe("the human's keeper (ask 8)", () => {
  function keeperHas() {
    const s = livePlay(6, 0);
    const gk = goalkeeper(s, 0);
    isolate(s, gk);
    gk.stun = 0;
    gk.pos = { x: 6, y: PITCH_H / 2 };
    gk.vel = { x: 0, y: 0 };
    // A soft shot he catches.
    fire(s, { x: 14, y: PITCH_H / 2 }, { x: -8, y: 0 });
    s.ball.lastTouch = s.players.find((p) => p.team === 1 && p.role === 'FWD')!.i;
    let t = 0;
    while (s.ball.owner !== gk.i && t++ < 60) step(s, { cursor: { x: 40, y: 30 } });
    return { s, gk };
  }

  test('when he catches it, control goes to him and he waits for the human: no auto-distribution', () => {
    const { s, gk } = keeperHas();
    expect(s.ball.owner).toBe(gk.i);
    expect(s.ball.inHands).toBe(true);
    expect(s.controlled[0]).toBe(gk.i);
    expect(keeperControllable(s, gk)).toBe(true);
    // Five seconds of a still pointer upfield: he holds it and does not walk out of his box.
    for (let t = 0; t < 300; t++) step(s, { cursor: { x: 40, y: 30 } });
    expect(s.ball.owner).toBe(gk.i);
    expect(gk.pos.x).toBeLessThan(16);
  });

  test('Law 12: holding the ball he cannot be bundled over his own line by a pressing forward, and releases it at the countdown', () => {
    const { s, gk } = keeperHas();
    expect(s.ball.owner).toBe(gk.i);
    gk.pos = { x: 1.5, y: PITCH_H / 2 };
    const fwd = s.players.find((p) => p.team === 1 && p.role === 'FWD')!;
    fwd.stun = 0;
    // The forward leans on him from the front for the whole six seconds.
    let released = -1;
    const goals = s.score[1] + s.score[0];
    for (let t = 0; t < KEEPER_HOLD_TICKS + 120 && released < 0; t++) {
      fwd.pos = { x: gk.pos.x + 0.6, y: gk.pos.y + 0.1 };
      fwd.vel = { x: -6, y: 0 };
      step(s, { cursor: { x: 40, y: 30 } });
      expect(gk.pos.x).toBeGreaterThan(0.45);
      if (s.ball.owner !== gk.i) released = t;
    }
    expect(s.score[1] + s.score[0]).toBe(goals);
    expect(released).toBeGreaterThan(KEEPER_HOLD_TICKS - 30);
  });

  test('Law 12: an opponent standing close may not stop the keeper releasing it', () => {
    // Auto-release at the countdown, and a human click, with a forward standing right in front of him.
    for (const human of [false, true]) {
      for (const dy of [-0.8, -0.3, 0, 0.3, 0.8]) {
        const { s, gk } = keeperHas();
        const fwd = s.players.find((p) => p.team === 1 && p.role === 'FWD')!;
        fwd.stun = 0;
        const mate = s.players.find((p) => p.team === 0 && p.role === 'DEF')!;
        mate.stun = 0;
        mate.pos = { x: 25, y: gk.pos.y + dy * 10 };
        let released = -1;
        for (let t = 0; t < KEEPER_HOLD_TICKS + 120; t++) {
          if (released < 0) {
            fwd.pos = { x: gk.pos.x + 1.4, y: gk.pos.y + dy };
            fwd.vel = { x: 0, y: 0 };
          }
          const click = human && t === 60;
          step(s, click ? { cursor: mate.pos, aim: mate.pos, pass: true } : { cursor: { x: 40, y: 30 } });
          if (released < 0 && s.ball.owner !== gk.i) released = t;
          if (released >= 0 && t - released < 20) expect(s.players[s.ball.lastTouch].team).toBe(0);
          if (released >= 0 && t - released >= 20) break;
        }
        expect(released).toBeGreaterThan(-1);
      }
    }
  });

  test('a click rolls it out, a right click punts it long', () => {
    const a = keeperHas();
    const mate = a.s.players.find((p) => p.team === 0 && p.role === 'DEF')!;
    mate.stun = 0;
    mate.pos = { x: 20, y: 20 };
    step(a.s, { cursor: mate.pos, aim: mate.pos, pass: true });
    expect(a.s.ball.owner).toBe(-1);
    expect(a.s.ball.receiver).toBe(mate.i);
    expect(a.s.ball.z).toBe(0);
    // Control moves to an outfielder as soon as the keeper has let it go.
    expect(a.s.players[a.s.controlled[0]].role).not.toBe('GK');

    const b = keeperHas();
    step(b.s, { cursor: { x: 70, y: 30 }, aim: { x: 70, y: 30 }, shoot: 0.8 });
    expect(b.s.ball.owner).toBe(-1);
    expect(b.s.ball.vz).toBeGreaterThan(5);
    let land: Vec | null = null;
    let air = false;
    for (let t = 0; t < 300 && !land; t++) {
      step(b.s, { cursor: { x: 70, y: 30 } });
      if (b.s.ball.z > 0) air = true;
      else if (air) land = { ...b.s.ball.pos };
    }
    expect(land!.x - 6).toBeGreaterThan(PUNT_MIN_RANGE);
    expect(b.s.stats[0].shots).toBe(0);
  });

  test('the long view stays up the whole time he holds it, and lets go once he has played it', () => {
    const { s, gk } = keeperHas();
    let t = 0;
    while (s.ball.owner === gk.i && s.ball.inHands && t++ < KEEPER_HOLD_TICKS + 120) {
      expect(longView(s, 0)).not.toBeNull();
      step(s, { cursor: { x: 40, y: 30 } });
    }
    expect(t).toBeGreaterThan(KEEPER_HOLD_TICKS - 30);
    expect(longView(s, 0)).toBeNull();
  });

  test('Law 12: after about six seconds in his hands the CPU plays it for the human', () => {
    const { s, gk } = keeperHas();
    let released = -1;
    for (let t = 0; t < KEEPER_HOLD_TICKS + 120 && released < 0; t++) {
      step(s, { cursor: { x: 40, y: 30 } });
      if (s.ball.owner !== gk.i) released = t;
    }
    expect(released).toBeGreaterThan(KEEPER_HOLD_TICKS - 30);
    expect(released).toBeLessThan(KEEPER_HOLD_TICKS + 120);
  });

  test("goal kicks: the human takes them through the keeper; the CPU doesn't take it first", () => {
    const s = livePlay(6, 0);
    awardRestart(s, 'goalkick', 0, { x: 0, y: 20 }, 'out');
    const gk = goalkeeper(s, 0);
    let t = 0;
    while (s.restart && s.restart.stage !== 'ready' && t++ < 600) step(s, { cursor: { x: 30, y: 30 } });
    expect(s.restart!.taker).toBe(gk.i);
    expect(s.controlled[0]).toBe(gk.i);
    for (let k = 0; k < RESTART_HUMAN_WAIT - 10; k++) step(s, { cursor: { x: 30, y: 30 } });
    expect(s.phase).toBe('restart');
    const mate = s.players.find((p) => p.team === 0 && p.role === 'DEF')!;
    step(s, { cursor: mate.pos, aim: mate.pos, pass: true });
    expect(s.phase).toBe('play');
    expect(s.ball.lastTouch).toBe(gk.i);
  });

  test("a CPU side's keeper still distributes by himself", () => {
    const s = livePlay(6, 0);
    const gk = goalkeeper(s, 1);
    s.ball.owner = gk.i;
    s.ball.inHands = true;
    s.ball.pos = { ...gk.pos };
    let t = 0;
    while (s.ball.owner === gk.i && t++ < 300) step(s, { cursor: { x: 40, y: 30 } });
    expect(s.ball.owner).not.toBe(gk.i);
    expect(t).toBeLessThan(120);
  });
});

// ---------------------------------------------------------------------------
// Stats

describe('match stats are meaningful', () => {
  test('possession counts the ball travelling between teammates and no dead-ball time', () => {
    const { s, mate } = passScene({ x: 30, y: 30 }, { x: 50, y: 30 });
    const p0 = s.stats[0].possessionTicks;
    step(s, { cursor: mate.pos, aim: mate.pos, pass: true });
    let t = 1;
    while (s.ball.owner !== mate.i && t++ < 120) step(s, { cursor: mate.pos });
    // Every tick of the pass counted for us, though nobody had the ball.
    expect(s.stats[0].possessionTicks - p0).toBe(t);
    expect(s.stats[1].possessionTicks).toBe(0);
    // Dead ball: not counted.
    awardRestart(s, 'throwin', 1, { x: 50, y: 0 }, 'out');
    const before = [s.stats[0].possessionTicks, s.stats[1].possessionTicks];
    for (let k = 0; k < 20; k++) step(s, { cursor: mate.pos });
    expect([s.stats[0].possessionTicks, s.stats[1].possessionTicks]).toEqual(before);
  });

  test('a completed lofted pass counts as a pass, and attempts are counted too', () => {
    const { s, mate } = passScene({ x: 30, y: 30 }, { x: 52, y: 30 });
    const before = { ...s.stats[0] }; // the kick-off pass
    step(s, { cursor: mate.pos, aim: mate.pos, loft: 0.6 });
    expect(s.stats[0].passAttempts - before.passAttempts).toBe(1);
    let t = 0;
    while (s.ball.owner !== mate.i && t++ < 300) step(s, { cursor: mate.pos });
    expect(s.ball.owner).toBe(mate.i);
    expect(s.stats[0].passes - before.passes).toBe(1);
    expect(s.stats[0].shots - before.shots).toBe(0);
  });

  test('a chip at goal is a shot, not a pass attempt', () => {
    const { s, me } = passScene({ x: PITCH_W - 18, y: PITCH_H / 2 }, { x: 40, y: 10 });
    void me;
    const before = { ...s.stats[0] }; // the kick-off pass
    step(s, { cursor: { x: PITCH_W, y: PITCH_H / 2 }, aim: { x: PITCH_W, y: PITCH_H / 2 }, loft: 0.3 });
    expect(s.stats[0].shots - before.shots).toBe(1);
    expect(s.stats[0].passAttempts - before.passAttempts).toBe(0);
  });

  test('CPU matches split possession and pass sensibly', () => {
    let passes = 0;
    let attempts = 0;
    for (const seed of [2, 3, 4]) {
      const s = createMatch({ seed, ...teams(seed + 1), halfSeconds: 60, humanTeam: -1 });
      while (s.phase !== 'fulltime') step(s);
      const [a, b] = possessionShare(s);
      expect(a + b).toBe(100);
      expect(a).toBeGreaterThan(25);
      expect(b).toBeGreaterThan(25);
      for (const st of s.stats) {
        expect(st.passes).toBeLessThanOrEqual(st.passAttempts);
        expect(st.onTarget).toBeLessThanOrEqual(st.shots);
        passes += st.passes;
        attempts += st.passAttempts;
      }
    }
    // Clearances and long balls count as attempts, so this is below a pure ground-pass rate.
    expect(passes / attempts).toBeGreaterThan(0.45);
  });
});

// ---------------------------------------------------------------------------
// Determinism and replays

describe('determinism with the new physics and inputs', () => {
  function script(t: number): HumanInput {
    const c = { x: 30 + 20 * Math.sin(t / 50), y: 34 + 18 * Math.cos(t / 37) };
    const i: HumanInput = { cursor: c };
    if (t % 3 !== 0) i.moved = true;
    if (t % 45 === 0) Object.assign(i, { pass: true, aim: { x: c.x + 1.23, y: c.y - 0.45 } });
    if (t % 160 === 7) Object.assign(i, { loft: 0.5, aim: c });
    if (t % 230 === 11) Object.assign(i, { shoot: 0.7, aim: { x: PITCH_W, y: PITCH_H / 2 } });
    if (t % 97 === 5) Object.assign(i, { select: true, aim: c });
    if (t % 131 === 9) i.tackle = true;
    return i;
  }

  test('two runs are identical, and a state cloned mid-match (dives, holds, queued kicks) carries on identically', () => {
    const run = () => {
      const s = createMatch({ seed: 21, ...teams(5), halfSeconds: 40 });
      for (let t = 0; t < 2400; t++) step(s, script(t));
      return s;
    };
    const a = run();
    expect(fingerprint(run())).toBe(fingerprint(a));
    const copy = structuredClone(a) as MatchState;
    for (let t = 2400; t < 4000; t++) {
      step(a, script(t));
      step(copy, script(t));
    }
    expect(fingerprint(copy)).toBe(fingerprint(a));
  });

  test('aim and moved survive quantising and the replay code (format 4), and the replay re-simulates exactly', () => {
    expect(quantiseInput({ cursor: { x: 1.234, y: 2 }, aim: { x: 3.456, y: 4.001 }, moved: true })).toEqual({ cursor: { x: 1.23, y: 2 }, aim: { x: 3.46, y: 4 }, moved: true });
    const opts = { seed: 8, ...teams(8), halfSeconds: 20, humanTeam: 0 as const };
    const s = createMatch(opts);
    const rec = new ReplayRecorder(opts, 'phys');
    let n = 0;
    while (s.phase !== 'fulltime') step(s, rec.push(script(n++)));
    const r = rec.finish(s, 1_700_000_000);
    const back = decodeReplay(encodeReplay(r));
    expect(back.runs).toEqual(r.runs);
    expect(finalHash(replayTo(back, back.ticks))).toBe(r.fp);
  });
});

describe('the woodwork', () => {
  /** A ball fired from `from` at `speed` toward (PITCH_W, yAim) at height z, nobody on the pitch. Where does it go? */
  function atGoal(from: Vec, yAim: number, speed: number, z: number, vz = 0) {
    const s = livePlay(3, -1);
    isolate(s);
    const d = Math.hypot(PITCH_W - from.x, yAim - from.y);
    const v0 = { x: ((PITCH_W - from.x) / d) * speed, y: ((yAim - from.y) / d) * speed };
    fire(s, from, v0, z, vz);
    const goals = s.score[0] + s.score[1];
    let turned = 0;
    // The biggest one-tick change of velocity near the goal line, gravity aside: a knock off the woodwork.
    let jolt = 0;
    for (let t = 0; t < 120 && s.phase === 'play'; t++) {
      const was = { ...s.ball.vel, z: s.ball.vz };
      step(s);
      const v = s.ball.vel;
      const c = (v.x * v0.x + v.y * v0.y) / (Math.hypot(v.x, v.y) * speed || 1);
      turned = Math.max(turned, Math.acos(Math.max(-1, Math.min(1, c))));
      if (Math.abs(s.ball.pos.x - PITCH_W) < 1.5)
        jolt = Math.max(jolt, Math.hypot(v.x - was.x, v.y - was.y, s.ball.vz - was.z + 9.8 / 60));
    }
    return { goal: s.score[0] + s.score[1] > goals, turned, jolt };
  }

  test('a shot whose path clips a post comes off it at any pace: it never passes through the post', () => {
    // Before: only where the ball ended each tick was tested against the post, so a 26 m/s shot
    // (0.43 m a tick, more than the post and ball together) went straight through 46-100% of the time.
    for (const speed of [14, 20, 26, 30])
      for (const [post, side] of [[GOAL_TOP, -1], [GOAL_BOTTOM, 1]] as const)
        for (const off of [-0.12, -0.06, 0, 0.06, 0.12]) {
          // From 6 m out and low, so it reaches the post before it has bounced and slowed.
          const r = atGoal({ x: PITCH_W - 6, y: PITCH_H / 2 + side * 4 }, post + off, speed, 0.2);
          expect(r.turned).toBeGreaterThan(0.1);
        }
  });

  test('a shot at the height of the bar comes off it: over it, down off it, or back out, never through it', () => {
    // Before: the bar had no body at all; a ball at the line under 2.33 m was a goal and over it was over.
    for (const speed of [18, 24, 30]) {
      for (const zLine of [2.36, 2.44, 2.52]) {
        // Fired from 3 m out, rising so that it reaches the line at zLine (gravity only matters a little here).
        const t = 3 / speed;
        const z0 = 1.5;
        const vz = (zLine - z0 + 0.5 * 9.8 * t * t) / t;
        const r = atGoal({ x: PITCH_W - 3, y: PITCH_H / 2 + 1 }, PITCH_H / 2 + 1, speed, z0, vz);
        // It came off the bar: a sharp knock at the line (back out, or up or down off it).
        expect(r.jolt).toBeGreaterThan(3);
      }
    }
  });
});

describe('a corner played to a team-mate', () => {
  /** Our corner; once it is ready the human clicks (a ground pass) on our man nearest the flag or the taker, past the short man. Who has it 4 s later? */
  function cornerTo(at: Vec, by: 'flag' | 'taker', seed: number) {
    const s = livePlay(seed + 10);
    awardRestart(s, 'corner', 0, { ...at }, 'out');
    let t = 0;
    while (s.restart && s.restart.stage !== 'ready' && t++ < 900) step(s, { cursor: { x: 90, y: 34 } });
    const taker = s.players[s.restart!.taker];
    const ref = by === 'flag' ? s.restart!.spot : taker.pos;
    // Not the man who comes short to the flag (tests/corners.test.ts): the nearest of the others, out on the edge of the box.
    const mate = s.players.filter((p) => p.team === 0 && p.i !== taker.i && p.role !== 'GK' && dist(p.pos, s.restart!.spot) > 30).sort((a, b) => dist(a.pos, ref) - dist(b.pos, ref))[0];
    step(s, { cursor: { ...mate.pos }, aim: { ...mate.pos }, pass: true, moved: true });
    let high = 0;
    for (let k = 0; k < 240 && s.ball.owner < 0 && s.phase === 'play'; k++) {
      step(s, { cursor: { ...mate.pos } });
      high = Math.max(high, s.ball.z);
    }
    const o = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
    return { high, ours: !!o && o.team === 0, him: o === mate };
  }

  test('our nearest man is on the edge of the box, 40 m away: the click is crossed to him, and our side usually keeps it', () => {
    let ours = 0;
    let him = 0;
    let n = 0;
    for (const at of [{ x: 105, y: 0 }, { x: 105, y: 68 }])
      for (const by of ['flag', 'taker'] as const)
        for (let seed = 1; seed <= 6; seed++) {
          const r = cornerTo(at, by, seed);
          n++;
          if (r.ours) ours++;
          if (r.him) him++;
          // A long pass from a corner goes in the air, over the box, not along the ground through it.
          expect(r.high).toBeGreaterThan(1.5);
        }
    // Played along the ground through the box it was cut out: our side kept it 0 of these 24, him 0.
    expect(ours / n).toBeGreaterThan(0.5);
    expect(him / n).toBeGreaterThan(0.3);
  }, 60_000);
});

describe('a keeper and a cross', () => {
  /** Our man lofts it from the wing (the human's loft) to `land`; their keeper (goalkeeping `skill`) is alone. Does he hold it? */
  function cross(seed: number, skill: number, from: Vec, land: Vec): boolean {
    const s = livePlay(seed);
    const gk = goalkeeper(s, 1);
    const me = mid(s, 0);
    isolate(s, gk, me);
    gk.stun = 0;
    gk.attrs.goalkeeping = skill;
    s.switchTimer[0] = 1e9;
    s.controlled[0] = me.i;
    me.pos = { ...from };
    me.vel = { x: 0, y: 0 };
    me.stun = 0;
    me.facing = { x: 1, y: 0 };
    fire(s, { x: from.x + 0.99, y: from.y }, { x: 0, y: 0 });
    s.ball.owner = me.i;
    s.ball.lastTouch = me.i;
    const loft = Math.max(0, Math.min(1, (dist(from, land) - 12) / 28 + 0.05));
    step(s, { cursor: land, aim: land, loft, moved: true });
    for (let t = 0; t < 300 && s.phase === 'play' && s.ball.owner !== gk.i; t++) step(s, { cursor: { ...me.pos } });
    return s.ball.owner === gk.i;
  }
  const claims = (skill: number, x: number) => {
    let n = 0;
    let held = 0;
    for (const wing of [4, PITCH_H - 4])
      for (const dy of [-4, -2, 0, 2, 4])
        for (const seed of [1, 2, 3, 4]) {
          n++;
          if (cross(seed, skill, { x: 82 + 2 * seed, y: wing }, { x, y: PITCH_H / 2 + dy })) held++;
        }
    return held / n;
  };

  test('nobody near him, he comes and holds a cross dropping into his six-yard box', () => {
    // Before: he went to where it first came into reach, a metre off its line, and it dropped past
    // him: under 20% held, whatever his goalkeeping.
    expect(claims(0.6, PITCH_W - 3.5)).toBeGreaterThan(0.85);
  }, 30_000);

  test('a better keeper comes further for one', () => {
    // Before: he came no further than 7-8 m, whatever his goalkeeping: 23% held at 10 m for 0.4 and 0.8 alike.
    const weak = claims(0.4, PITCH_W - 10);
    const strong = claims(0.8, PITCH_W - 10);
    console.log(`crosses held at 10 m: keeper 0.4 ${(weak * 100).toFixed(0)}%, keeper 0.8 ${(strong * 100).toFixed(0)}%`);
    expect(strong).toBeGreaterThan(weak + 0.1);
  }, 30_000);
});
