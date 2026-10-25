// Controls feel: the red-team round 1b controls findings (loose balls, tackles, lofted passes,
// clicks) as tests. Each measures what the finding measured, and failed on main 96f9618.

import { describe, expect, test } from 'bun:test';
import { DOUBLE_CLICK_MS, InputController } from '../src/client/input.ts';
import { isPinch, PINCH_GAIN, wheelZoom } from '../src/client/renderer.ts';
import { MatchCamera } from '../src/client/r3d/camera3d.ts';
import { pickable, pickBody } from '../src/client/r3d/renderer3d.ts';
import { sx, sz, wx, wy } from '../src/client/r3d/space.ts';
import { Plane, Raycaster, Vector2, Vector3 } from '../src/client/r3d/three.ts';
import { TIPS } from '../src/client/coach.ts';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { createMatch, step } from '../src/sim/match.ts';
import { awardRestart } from '../src/sim/rules.ts';
import type { HumanInput, MatchPlayer, MatchState } from '../src/sim/types.ts';
import { openPlay } from './helpers.ts';
import { dist, len, type Vec } from '../src/sim/vec.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

function livePlay(seed = 5): MatchState {
  const s = createMatch({ seed, ...teams(7), halfSeconds: 600, humanTeam: 0 });
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

const role = (s: MatchState, team: 0 | 1, r: string, k = 0) => s.players.filter((p) => p.team === team && p.role === r)[k];

/** The human steers `me`, running at `speed` along +x from `at`; nobody else around. */
function runner(at: Vec, speed: number) {
  const s = livePlay();
  const me = role(s, 0, 'MID');
  isolate(s, me);
  s.switchTimer[0] = 1e9;
  s.controlled[0] = me.i;
  if (s.ctlHold) s.ctlHold[0] = false;
  me.pos = { ...at };
  me.vel = { x: speed, y: 0 };
  me.facing = { x: 1, y: 0 };
  me.stun = 0;
  return { s, me };
}

// ---------------------------------------------------------------------------
// Major 1: a steered player who takes the ball is not stopped dead

describe('the player you are steering keeps running when he takes the ball', () => {
  test('collecting a loose ball with the pointer resting ahead: still running 20 and 40 ticks later', () => {
    const { s, me } = runner({ x: 40, y: 34 }, 8);
    s.ball.owner = -1;
    s.ball.pos = { x: 44, y: 34 };
    s.ball.vel = { x: 0, y: 0 };
    s.ball.z = 0;
    // The hand moves the pointer out ahead, then rests 10+ m in front of him.
    const ahead = { x: 60, y: 34 };
    for (let t = 0; t < 12; t++) step(s, { cursor: { x: 48 + t, y: 34 }, moved: true });
    let got = -1;
    const speeds: number[] = [];
    for (let t = 0; t < 120; t++) {
      step(s, { cursor: ahead });
      if (got < 0 && s.ball.owner === me.i) got = t;
      if (got >= 0) speeds.push(len(me.vel));
      if (speeds.length > 41) break;
    }
    expect(got).toBeGreaterThanOrEqual(0);
    expect(speeds[20]).toBeGreaterThan(4);
    expect(speeds[40]).toBeGreaterThan(4);
    expect(s.ctlHold?.[0]).toBe(false);
  });

  test('a through ball into space onto a runner the human steers: he runs on with it', () => {
    const { s, me } = runner({ x: 40, y: 34 }, 7);
    // A ball played into space ahead of him (no receiver), still rolling.
    s.ball.owner = -1;
    s.ball.pos = { x: 45, y: 34.3 };
    s.ball.vel = { x: 4, y: 0 };
    s.ball.z = 0;
    s.ball.receiver = -1;
    s.ball.lastTouch = role(s, 0, 'DEF').i;
    const ahead = { x: 62, y: 34 };
    for (let t = 0; t < 10; t++) step(s, { cursor: { x: 52 + t, y: 34 }, moved: true });
    let got = -1;
    const speeds: number[] = [];
    for (let t = 0; t < 120; t++) {
      step(s, { cursor: ahead });
      if (got < 0 && s.ball.owner === me.i) got = t;
      if (got >= 0) speeds.push(len(me.vel));
      if (speeds.length > 31) break;
    }
    expect(got).toBeGreaterThanOrEqual(0);
    expect(speeds[20]).toBeGreaterThan(4);
    expect(speeds[30]).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// Major 2: right-click tackles win the ball where the click says they can

/** A CPU carrier at (40,34) running at our defender (from the front unless `still`); the human right-clicks on him from `gap` m. Watches 30 ticks. */
function tackleAt(gap: number, seed: number, opts: { still?: boolean; pointer?: 'carrier' | 'ball' } = {}) {
  const s = livePlay(seed);
  const me = role(s, 0, 'DEF');
  const opp = role(s, 1, 'MID');
  isolate(s, me, opp);
  s.controlled[0] = me.i;
  s.switchTimer[0] = 1e9;
  const v = opts.still ? 0 : -5;
  opp.pos = { x: 40, y: 34 };
  opp.vel = { x: v, y: 0 };
  opp.facing = { x: -1, y: 0 };
  opp.stun = 0;
  const b = s.ball;
  Object.assign(b, { owner: opp.i, pos: { x: 39, y: 34 }, vel: { x: v, y: 0 }, z: 0, vz: 0, receiver: -1, lastTouch: opp.i });
  b.noPickup.fill(0);
  me.stun = 0;
  me.tackleCd = 0;
  me.pos = { x: 40 - gap, y: 34 };
  me.vel = { x: 0, y: 0 };
  me.facing = { x: 1, y: 0 };
  const aim = opts.pointer === 'ball' ? { ...b.pos } : { ...opp.pos };
  const fouls0 = s.stats[0].fouls;
  const tk0 = s.stats[0].tackles;
  step(s, { cursor: aim, aim, tackle: true, moved: true });
  let closest = dist(me.pos, b.pos);
  // A tackle that reaches the man and loses the ball leaves a long cooldown (90 ticks for a slide,
  // 50 standing); one that never reaches him only the cooldown it started with (70 / 36).
  let lost = me.tackleCd > 70 || me.tackleCd === 50;
  for (let t = 0; t < 30 && s.phase === 'play' && s.stats[0].tackles === tk0; t++) {
    step(s, { cursor: aim });
    closest = Math.min(closest, dist(me.pos, b.pos));
    if (me.tackleCd > 70) lost = true;
  }
  const won = s.stats[0].tackles > tk0;
  const foul = s.stats[0].fouls > fouls0 || s.phase === 'restart';
  return { won, foul, judged: won || foul || lost, closest };
}

describe('a slide at a keeper holding the ball', () => {
  test('is a foul (Law 12), and the keeper keeps the ball', () => {
    let fouls = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const s = livePlay(seed);
      const me = role(s, 0, 'FWD');
      const gk = s.players.find((p) => p.team === 1 && p.role === 'GK')!;
      isolate(s, me, gk);
      s.controlled[0] = me.i;
      s.switchTimer[0] = 1e9;
      gk.pos = { x: 100, y: 34 };
      gk.vel = { x: 0, y: 0 };
      gk.stun = 0;
      Object.assign(s.ball, { owner: gk.i, inHands: true, pos: { x: 100, y: 34 }, vel: { x: 0, y: 0 }, z: 1.1, vz: 0, receiver: -1, lastTouch: gk.i });
      me.pos = { x: 96.5, y: 34 };
      me.vel = { x: 0, y: 0 };
      me.stun = 0;
      me.tackleCd = 0;
      const n = s.events.length;
      step(s, { cursor: { x: 100, y: 34 }, aim: { x: 100, y: 34 }, tackle: true, moved: true });
      for (let k = 0; k < 30 && s.phase === 'play'; k++) step(s, { cursor: { x: 100, y: 34 } });
      if (s.events.slice(n).some((e) => e.kind === 'foul' && e.player === me.i)) fouls++;
      expect(s.ball.owner === gk.i || s.phase === 'restart').toBe(true);
      expect(me.slide ?? null).toBeNull();
    }
    // The review on 26f49fb: the slide passed through him with no contact and no foul.
    expect(fouls).toBeGreaterThanOrEqual(8);
  });
});

describe('right-click tackles (no dead band, slides that reach the ball can win it)', () => {
  const seeds = Array.from({ length: 30 }, (_, i) => i + 1);

  test('a standing tackle with the pointer on a carrier 1.8-2.3 m away can win the ball', () => {
    for (const gap of [1.8, 2.0, 2.3]) {
      const rs = seeds.map((sd) => tackleAt(gap, sd));
      const won = rs.filter((r) => r.won).length;
      // Main: 0 of 30 at every one of these distances.
      expect(won).toBeGreaterThanOrEqual(6);
    }
  });

  test('a slide from 3.5-4.5 m at a carrier reaches him and is judged (won, lost or a foul); it never just slides into him and stops', () => {
    for (const gap of [3.5, 4, 4.5]) {
      for (const still of [false, true]) {
        const rs = seeds.map((sd) => tackleAt(gap, sd, { still }));
        const reached = rs.filter((r) => r.judged).length;
        // Main: 0 of 30 (the slide was judged once, at the click, against 3 m, and then slid on uselessly).
        expect(reached).toBeGreaterThanOrEqual(20);
        expect(rs.filter((r) => r.won).length).toBeGreaterThanOrEqual(6);
      }
    }
  });

  test('the pointer on the ball rather than the man makes no difference to which tackle it is', () => {
    const a = seeds.map((sd) => tackleAt(1.9, sd, { pointer: 'ball' }));
    expect(a.filter((r) => r.won).length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Major 3: a lofted pass to a team-mate is controlled where it lands

/** The human (a MID at (10,34), in our own half so nobody is offside) lofts to a team-mate `d` m away along +x; nobody else on the pitch. */
function loftScene(d: number, seed = 5) {
  const s = livePlay(seed);
  const me = role(s, 0, 'MID');
  const mate = role(s, 0, 'MID', 1);
  isolate(s, me, mate);
  s.switchTimer[0] = 1e9;
  s.controlled[0] = me.i;
  me.pos = { x: 10, y: 34 };
  me.vel = { x: 0, y: 0 };
  me.facing = { x: 1, y: 0 };
  me.stun = 0;
  mate.pos = { x: 10 + 0.99 + d, y: 34 };
  mate.vel = { x: 0, y: 0 };
  mate.stun = 0;
  Object.assign(s.ball, { owner: me.i, pos: { x: 10.99, y: 34 }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1 });
  return { s, me, mate };
}

/** Play the loft with the pointer on the team-mate, then `mode` with the pointer. When and where does our side control it? */
function loftTo(d: number, mode: 'still' | 'jiggle', seed = 5) {
  const { s, mate } = loftScene(d, seed);
  const aim = { ...mate.pos };
  const hold = Math.min(1, (d - 12) / 28 + 0.05);
  step(s, { cursor: aim, aim, loft: hold });
  let landed = -1;
  for (let t = 1; t < 600; t++) {
    const jig = mode === 'jiggle' ? { x: aim.x + (t % 2 ? 0.3 : -0.3), y: aim.y } : aim;
    step(s, { cursor: jig, moved: mode === 'jiggle' });
    if (landed < 0 && s.ball.z === 0 && s.ball.owner < 0) landed = t;
    const o = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
    // Taken before it ever lands (on the chest or thigh) counts as no time after landing.
    if (o) return { ours: o.team === 0, landed, at: t, late: landed < 0 ? 0 : t - landed, off: dist(s.ball.pos, aim) };
  }
  return { ours: false, landed, at: 600, late: Infinity, off: Infinity };
}

describe('lofted passes to a team-mate (hold left)', () => {
  test('to a team-mate standing on the spot, 15-30 m: he controls it within half a second of it landing, near the aim', () => {
    for (const d of [15, 20, 25, 30]) {
      for (const mode of ['still', 'jiggle'] as const) {
        const r = loftTo(d, mode);
        // Main: it came off him and skipped on 13-23 m; nobody had it for seconds.
        expect(r.ours).toBe(true);
        expect(r.late).toBeLessThanOrEqual(30);
        expect(r.off).toBeLessThan(4);
      }
    }
  });

  test('over a range of seeds and 15-35 m, nearly every loft to a free team-mate is kept, and quickly', () => {
    let kept = 0;
    let quick = 0;
    let n = 0;
    for (const d of [15, 20, 25, 30, 35]) {
      for (let seed = 1; seed <= 6; seed++) {
        const r = loftTo(d, 'still', seed);
        n++;
        if (r.ours) kept++;
        if (r.ours && r.at < 2.6 * 60 + 30) quick++;
      }
    }
    expect(kept / n).toBeGreaterThan(0.9);
    expect(quick / n).toBeGreaterThan(0.8);
  });

  test('a loft into space with nobody else near: the man the human is given goes to it even with a resting pointer', () => {
    const { s, me, mate } = loftScene(10);
    s.switchTimer[0] = 0; // the human is handed whoever is nearest the ball, as in a match
    // Aim at empty grass 25 m away, well wide of the team-mate.
    const aim = { x: 35, y: 50 };
    step(s, { cursor: aim, aim, loft: 0.5 });
    const rest = { x: 25, y: 20 };
    let ours = -1;
    for (let t = 1; t < 600 && ours < 0; t++) {
      step(s, { cursor: rest });
      if (s.ball.owner >= 0 && s.players[s.ball.owner].team === 0) ours = t;
    }
    // Main: the held man is positioned by the CPU and nobody chases; it rolls on untouched.
    expect(ours).toBeGreaterThan(0);
    expect(ours).toBeLessThan(4 * 60);
    expect([me.i, mate.i]).toContain(s.ball.owner);
  });
});

// ---------------------------------------------------------------------------
// Minor: double clicks

/** The human at (20,34) with the ball; a team-mate `d` m on. */
function dblScene(d: number) {
  const s = livePlay(3);
  const me = role(s, 0, 'MID');
  const mate = role(s, 0, 'MID', 1);
  isolate(s, me, mate);
  s.switchTimer[0] = 1e9;
  s.controlled[0] = me.i;
  me.pos = { x: 20, y: 34 };
  me.vel = { x: 0, y: 0 };
  me.facing = { x: 1, y: 0 };
  me.stun = 0;
  mate.pos = { x: 20 + d, y: 34 };
  mate.vel = { x: 0, y: 0 };
  mate.stun = 0;
  Object.assign(s.ball, { owner: me.i, pos: { x: 20.99, y: 34 }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1 });
  return { s, me, mate };
}

describe('a double click is not two actions', () => {
  test('sim: a second left press on the receiver while the pass travels (the select the controller sends) leaves him the ball', () => {
    for (const [d, gap] of [[8, 5], [12, 6], [15, 8], [20, 10], [12, 20]] as const) {
      const { s, mate } = dblScene(d);
      const aim = { ...mate.pos };
      step(s, { cursor: aim, aim, pass: true, moved: true });
      for (let k = 1; k < gap; k++) step(s, { cursor: aim });
      step(s, { cursor: aim, aim, select: true });
      let t = 0;
      while (s.ball.owner !== mate.i && t++ < 200) step(s, { cursor: aim });
      expect(s.ball.owner).toBe(mate.i);
      // Main: he controlled it and pushed it straight on, 6-14 m from him.
      for (let k = 0; k < 40; k++) step(s, { cursor: aim });
      expect(s.ball.owner).toBe(mate.i);
      expect(dist(s.ball.pos, mate.pos)).toBeLessThan(1.5);
    }
  });

  test('sim: a second right press just after a shot does not slide the striker onto the floor', () => {
    for (const gap of [6, 10, 15]) {
      const { s, me } = dblScene(10);
      const goal = { x: 105, y: 34 };
      step(s, { cursor: goal, aim: goal, shoot: 0.6, moved: true });
      for (let k = 1; k < gap; k++) step(s, { cursor: goal });
      step(s, { cursor: goal, aim: goal, tackle: true });
      // Main: a slide toward the goal, 30 ticks on the floor and a 70-tick cooldown.
      expect(me.slide ?? null).toBeNull();
      expect(me.stun).toBe(0);
      expect(me.tackleCd).toBe(0);
    }
  });

  test('client: the controller drops a press without the ball that comes within DOUBLE_CLICK_MS of our kick', () => {
    const { s, mate } = dblScene(12);
    (globalThis as Record<string, unknown>).window ??= new EventTarget();
    const win = (globalThis as unknown as { window: EventTarget }).window;
    const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }) }) as unknown as HTMLCanvasElement;
    const picker = { toWorld: (x: number, y: number) => ({ x: x / 10, y: y / 10 }) };
    const input = new InputController(canvas, picker, () => s.ball.owner === s.controlled[0], () => {});
    const ev = (type: string, button: number) => {
      const e = new Event(type);
      for (const [k, v] of Object.entries({ clientX: mate.pos.x * 10, clientY: mate.pos.y * 10, pointerType: 'mouse', pointerId: 1, button, isPrimary: true })) Object.defineProperty(e, k, { value: v });
      return e;
    };
    canvas.dispatchEvent(ev('pointermove', 0));
    canvas.dispatchEvent(ev('pointerdown', 0));
    win.dispatchEvent(ev('pointerup', 0));
    const first = input.take();
    expect(first.pass).toBe(true);
    step(s, first);
    expect(s.ball.owner).toBe(-1);
    // The second press of a double click, a moment later: no ball now, so it would be a select (or a tackle).
    canvas.dispatchEvent(ev('pointerdown', 0));
    win.dispatchEvent(ev('pointerup', 0));
    canvas.dispatchEvent(ev('pointerdown', 2));
    win.dispatchEvent(ev('pointerup', 2));
    const second = input.take();
    expect(second.select).toBeUndefined();
    expect(second.tackle).toBeUndefined();
    expect(DOUBLE_CLICK_MS).toBeGreaterThanOrEqual(250);
    input.dispose();
  });
});

// ---------------------------------------------------------------------------
// Minor: a click while a restart is being set up

describe('a click while our restart is being set up', () => {
  for (const [kind, at] of [
    ['throwin', { x: 40, y: 0 }],
    ['goalkick', { x: 5.5, y: 30 }],
    ['corner', { x: 105, y: 0 }],
  ] as const) {
    test(`${kind}: is kept and played as soon as it is ready, not swallowed`, () => {
      const s = livePlay(6);
      awardRestart(s, kind, 0, { ...at }, 'out');
      let t = 0;
      while (s.restart && s.restart.stage === 'whistle' && t++ < 600) step(s, { cursor: { x: 50, y: 34 } });
      expect(s.restart?.stage).toBe('setup');
      const taker = s.players[s.restart!.taker];
      const mate = s.players.filter((p) => p.team === 0 && p.i !== taker.i && p.role !== 'GK').sort((a, b) => dist(a.pos, taker.pos) - dist(b.pos, taker.pos))[0];
      // Ten ticks into the set-up the player clicks on a team-mate, then waits.
      for (let k = 0; k < 10 && s.restart?.stage === 'setup'; k++) step(s, { cursor: mate.pos });
      expect(s.restart?.stage).toBe('setup');
      const n = s.events.length;
      step(s, { cursor: mate.pos, aim: { ...mate.pos }, pass: true, moved: true });
      let readyAt = -1;
      let takenAt = -1;
      for (let k = 0; k < 400 && takenAt < 0; k++) {
        if (readyAt < 0 && s.restart?.stage === 'ready') readyAt = k;
        step(s, { cursor: mate.pos });
        if (s.events.slice(n).some((e) => e.kind === 'restartTaken')) takenAt = k;
      }
      // Main: still waiting in 'ready' for a second click until the CPU took it 5 s later.
      expect(readyAt).toBeGreaterThanOrEqual(0);
      expect(takenAt).toBeGreaterThanOrEqual(readyAt);
      expect(takenAt - readyAt).toBeLessThanOrEqual(2);
    });
  }
});

describe('a restart click made during set-up reaches the team-mate clicked', () => {
  /** Our restart; the human clicks the second-nearest team-mate (to the spot or to the taker) 10 ticks into set-up (`early`) or on the first ready tick. Did he get the ball? */
  function restartClick(kind: 'throwin' | 'goalkick' | 'corner', at: Vec, by: 'spot' | 'taker', seed: number, early: boolean) {
    const s = livePlay(seed + 10);
    awardRestart(s, kind, 0, { ...at }, 'out');
    let t = 0;
    while (s.restart && s.restart.stage === 'whistle' && t++ < 600) step(s, { cursor: { x: 50, y: 34 } });
    const taker = s.players[s.restart!.taker];
    for (let k = 0; k < 10; k++) step(s, { cursor: { ...taker.pos } });
    const ref = by === 'spot' ? s.restart!.spot : taker.pos;
    const mate = s.players.filter((p) => p.team === 0 && p.i !== taker.i && p.role !== 'GK').sort((a, b) => dist(a.pos, ref) - dist(b.pos, ref))[1];
    if (early) step(s, { cursor: { ...mate.pos }, aim: { ...mate.pos }, pass: true, moved: true });
    let clicked = early;
    for (let k = 0; k < 400 && s.restart; k++) {
      if (!clicked && s.restart.stage === 'ready') {
        clicked = true;
        step(s, { cursor: { ...mate.pos }, aim: { ...mate.pos }, pass: true, moved: true });
      } else step(s, { cursor: { ...mate.pos } });
    }
    for (let k = 0; k < 240 && s.ball.owner < 0 && s.phase === 'play'; k++) step(s, { cursor: { ...mate.pos } });
    return s.ball.owner === mate.i;
  }
  const reached = (kind: 'throwin' | 'goalkick' | 'corner', at: Vec, by: 'spot' | 'taker', early: boolean) => [1, 2, 3, 4, 5, 6].filter((sd) => restartClick(kind, at, by, sd, early)).length;

  test('a throw-in clicked on the second-nearest team-mate (to the taker) mid set-up reaches him', () => {
    // The re-review of b42481e: 0 of 6. The pass led him by his set-up walk, but he stops (or slows)
    // as he reaches his place, so the throw landed where he never went.
    expect(reached('throwin', { x: 70, y: 68 }, 'taker', true)).toBeGreaterThanOrEqual(5);
  });

  for (const [kind, at] of [
    ['throwin', { x: 40, y: 0 }],
    ['throwin', { x: 70, y: 68 }],
    ['goalkick', { x: 5.5, y: 30 }],
    ['corner', { x: 105, y: 0 }],
  ] as const) {
    test(`${kind} at (${at.x}, ${at.y}): a click mid set-up does at least as well as clicking him once the taker is ready`, () => {
      for (const by of ['spot', 'taker'] as const) expect(reached(kind, at, by, true)).toBeGreaterThanOrEqual(reached(kind, at, by, false));
    });
  }
});

// ---------------------------------------------------------------------------
// Minor: human shots rise with power, by shooting skill

/** The human strikes from `d` m out at the middle of the goal; nobody else on the pitch. Height as it crosses the line (or its peak if short). */
function shotHeight(d: number, power: number, shooting: number, seed: number, ahead?: number) {
  const s = livePlay(seed);
  const me = role(s, 0, 'FWD');
  isolate(s, me);
  s.controlled[0] = me.i;
  me.pos = { x: 105 - d - 1, y: 34 };
  me.vel = { x: 0, y: 0 };
  me.facing = { x: 1, y: 0 };
  me.stun = 0;
  me.attrs.shooting = shooting;
  Object.assign(s.ball, { owner: me.i, pos: { x: 105 - d, y: 34 }, vel: { x: 0, y: 0 }, z: 0, vz: 0, receiver: -1 });
  // The pointer on the goal line, or `ahead` m in front of the ball on the way there (as while dribbling).
  const goal = ahead === undefined ? { x: 105, y: 34 } : { x: 105 - d + ahead, y: 34 };
  step(s, { cursor: goal, aim: goal, shoot: power });
  let peak = 0;
  for (let t = 0; t < 120 && s.ball.pos.x < 105; t++) {
    step(s, { cursor: goal });
    peak = Math.max(peak, s.ball.z);
  }
  return { atLine: s.ball.pos.x >= 105 ? s.ball.z : peak, peak };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe('human shots rise with power', () => {
  const seeds = Array.from({ length: 21 }, (_, i) => i + 1);
  test('a quick click stays low; a full-power strike from 18-25 m rises to around 1.5-2.4 m at the goal line', () => {
    for (const d of [18, 25]) {
      const low = median(seeds.map((sd) => shotHeight(d, 0.55, 0.7, sd).atLine));
      const high = median(seeds.map((sd) => shotHeight(d, 1, 0.7, sd).atLine));
      // Main: 0.12-0.35 m at every power.
      expect(low).toBeLessThan(0.8);
      expect(high).toBeGreaterThan(1.4);
      expect(high).toBeLessThan(2.44);
    }
  });

  test('the rise is planned to the goal line, not the pointer: with the pointer 3, 6 or 10 m ahead a shot behaves as if aimed at the line', () => {
    for (const power of [0.8, 1]) {
      const atLine = seeds.map((sd) => shotHeight(18, power, 0.7, sd).atLine);
      const overLine = atLine.filter((h) => h > 2.44).length;
      for (const ahead of [3, 6, 10]) {
        const hs = seeds.map((sd) => shotHeight(18, power, 0.7, sd, ahead).atLine);
        // The review on 26f49fb: power 1 went over 20/20, 20/20 and 15/20 with the pointer 3/6/10 m ahead.
        expect(hs.filter((h) => h > 2.44).length).toBeLessThanOrEqual(overLine + 2);
        expect(Math.abs(median(hs) - median(atLine))).toBeLessThan(0.4);
      }
    }
  });

  test('it stays skill-based: a poor shooter puts a full-power strike over the bar more often than a good one', () => {
    const over = (shooting: number) => seeds.filter((sd) => shotHeight(20, 1, shooting, sd).atLine > 2.44).length;
    expect(over(0.2)).toBeGreaterThan(over(0.95));
    expect(over(0.95)).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Minor: trackpad pinch zooms the camera

describe('trackpad pinch (ctrl+wheel) zooms the camera', () => {
  test('15 pinch-out events of 4 px zoom the camera in clearly; a plain wheel still zooms as before', () => {
    let z = 1;
    for (let i = 0; i < 15; i++) z = wheelZoom(z, { deltaY: -4, deltaMode: 0, ctrlKey: true });
    // Main ignored ctrl+wheel (the page zoomed instead): z stayed 1.
    expect(z).toBeLessThan(0.75);
    let w = 1;
    for (let i = 0; i < 15; i++) w = wheelZoom(w, { deltaY: -4, deltaMode: 0, ctrlKey: false });
    expect(w).toBeGreaterThan(0.9);
    expect(PINCH_GAIN).toBeGreaterThan(1);
  });

  test('a mouse wheel with Ctrl held is left to the browser (page zoom); only a pinch is taken', () => {
    // Trackpad pinches: small, often fractional pixel deltas.
    for (const deltaY of [-4, 2.5, -0.75, 12]) expect(isPinch({ deltaY, deltaMode: 0, ctrlKey: true })).toBe(true);
    // A mouse notch with Ctrl: about 100 px, or lines.
    expect(isPinch({ deltaY: 100, deltaMode: 0, ctrlKey: true })).toBe(false);
    expect(isPinch({ deltaY: -120, deltaMode: 0, ctrlKey: true })).toBe(false);
    expect(isPinch({ deltaY: 3, deltaMode: 1, ctrlKey: true })).toBe(false);
    // No Ctrl: a plain scroll, zoomed by the camera as before.
    expect(isPinch({ deltaY: -4, deltaMode: 0, ctrlKey: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Minor: 3D clicks pick a player by his body, not the grass behind him

describe('3D: a click on a player\'s body picks him', () => {
  test('clicking his head, chest or waist picks him, not the team-mate 4 m behind (up-screen); the grass still picks the grass', () => {
    const W = 1040;
    const H = 697;
    const cam = new MatchCamera();
    for (let i = 0; i < 240; i++) cam.update(1 / 60, { x: sx(52), z: sz(34), vx: 0, vz: 0, air: 0, attack: 1, phase: 'play', close: null, humanDir: 1 }, W / H, W, false);
    const rc = new Raycaster();
    const ground = new Plane(new Vector3(0, 1, 0), 0);
    const hit = new Vector3();
    // Him at (60, 34); a team-mate 4 m further from the camera (up-screen, smaller sim y).
    const him = { x: 60, y: 34 };
    const behind = { x: 60, y: 30 };
    const bodies = [{ x: sx(behind.x), z: sz(behind.y) }, { x: sx(him.x), z: sz(him.y) }];
    const rayAt = (x: number, y: number, h: number) => {
      const v = new Vector3(sx(x), h, sz(y)).project(cam.camera);
      rc.setFromCamera(new Vector2(v.x, v.y), cam.camera);
      return rc.ray;
    };
    for (const h of [0.9, 1.3, 1.65]) {
      const ray = rayAt(him.x, him.y, h);
      ray.intersectPlane(ground, hit);
      const grass = { x: wx(hit.x), y: wy(hit.z) };
      // Main: the ground point, metres up-screen of his feet (toward the man behind for a head click).
      expect(dist(grass, him)).toBeGreaterThan(0.9);
      expect(pickBody(ray.origin, ray.direction, bodies)).toBe(1);
    }
    // Empty grass between and beside them picks no one.
    const empty = rayAt(64, 32, 0);
    expect(pickBody(empty.origin, empty.direction, bodies)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Minor: header aim is relative to the striker

/** A cross from the wing at head height to our striker at (96,34), the pointer resting at `pointer`. Where does the header cross the line? */
function headerAt(pointer: Vec, seed: number) {
  const s = livePlay(seed);
  const me = role(s, 0, 'FWD');
  const gk = s.players.find((p) => p.team === 1 && p.role === 'GK')!;
  isolate(s, me, gk);
  s.controlled[0] = me.i;
  s.switchTimer[0] = 1e9;
  me.pos = { x: 96, y: 34 };
  me.vel = { x: 0, y: 0 };
  me.facing = { x: 0, y: -1 };
  me.stun = 0;
  gk.pos = { x: 104, y: 34 };
  gk.vel = { x: 0, y: 0 };
  gk.stun = 1000; // he watches: we measure where it is aimed, not the save
  const t = 0.83;
  Object.assign(s.ball, { owner: -1, pos: { x: 96, y: 24 }, vel: { x: 0, y: 10 / t }, z: 2.3, vz: (2.0 - 2.3 + 0.5 * 9.8 * t * t) / t, receiver: -1, lastTouch: role(s, 0, 'MID').i });
  s.ball.noPickup.fill(0);
  let headed = false;
  for (let k = 0; k < 120; k++) {
    step(s, { cursor: pointer });
    if (!headed && s.ball.lastTouch === me.i) headed = true;
    if (headed && s.ball.pos.x >= 105) break;
  }
  return { headed, y: s.ball.pos.y, moved: dist(me.pos, { x: 96, y: 34 }) };
}

describe('a human header at goal goes where the pointer says, relative to the striker', () => {
  const seeds = Array.from({ length: 8 }, (_, i) => i + 1);
  test('pointer 1 m to the top-post side picks the top half of the goal, 1 m the other side the bottom half; on him, the middle', () => {
    // The hand rests: the pointer stays where it was put, 1 m to one side of him or on him.
    const top = seeds.map((sd) => headerAt({ x: 96, y: 33 }, sd));
    const bottom = seeds.map((sd) => headerAt({ x: 96, y: 35 }, sd));
    const mid = seeds.map((sd) => headerAt({ x: 96, y: 34 }, sd));
    for (const rs of [top, bottom, mid]) expect(rs.filter((r) => r.headed).length).toBeGreaterThanOrEqual(7);
    const meanY = (rs: { headed: boolean; y: number }[]) => rs.filter((r) => r.headed).reduce((a, r) => a + r.y, 0) / rs.filter((r) => r.headed).length;
    // Main: the pointer's absolute y (33 or 35 m) aimed it barely off centre: means 33.8 and 34.1.
    expect(meanY(top)).toBeLessThan(32.4);
    expect(meanY(bottom)).toBeGreaterThan(35.2);
    expect(Math.abs(meanY(mid) - 34)).toBeLessThan(1.2);
    expect(top.filter((r) => r.y < 34).length).toBeGreaterThanOrEqual(6);
    expect(bottom.filter((r) => r.y > 34).length).toBeGreaterThanOrEqual(6);
    // And he stays on the ball's line to head it: the pointer is under a metre from him.
    expect(Math.max(...top.map((r) => r.moved), ...bottom.map((r) => r.moved))).toBeLessThan(1.5);
  });
});

// ---------------------------------------------------------------------------
// Minor: the mouse coach tip mentions hold-to-loft

describe('coach tips', () => {
  test('the mouse pass tip tells you to hold for a lofted ball, as the touch tip does', () => {
    // Main: only the touch tip mentioned holding.
    expect(TIPS.pass.mouse).toMatch(/hold/i);
    expect(TIPS.pass.mouse).toMatch(/loft/i);
    expect(TIPS.pass.touch).toMatch(/loft/i);
  });
});

describe('3D body pick only on presses', () => {
  /** An InputController whose picker finds a body (at `body`) under every pixel, and grass at pixel / 10. */
  function rig(s: MatchState, body: Vec) {
    (globalThis as Record<string, unknown>).window ??= new EventTarget();
    const win = (globalThis as unknown as { window: EventTarget }).window;
    const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }) }) as unknown as HTMLCanvasElement;
    const picks: string[] = [];
    const picker = {
      toWorld: (x: number, y: number) => ({ x: x / 10, y: y / 10 }),
      pickPlayer: (_x: number, _y: number, who: 'mates' | 'opponents') => {
        picks.push(who);
        return { ...body };
      },
    };
    const input = new InputController(canvas, picker, () => s.ball.owner === s.controlled[0], () => {});
    const ev = (type: string, at: Vec, button = 0) => {
      const e = new Event(type);
      for (const [k, v] of Object.entries({ clientX: at.x * 10, clientY: at.y * 10, pointerType: 'mouse', pointerId: 1, button, isPrimary: true })) Object.defineProperty(e, k, { value: v });
      return e;
    };
    return { input, picks, move: (at: Vec) => canvas.dispatchEvent(ev('pointermove', at)), down: (at: Vec, b = 0) => canvas.dispatchEvent(ev('pointerdown', at, b)), up: (at: Vec, b = 0) => win.dispatchEvent(ev('pointerup', at, b)) };
  }

  test('steering over and through bodies follows the grass; a press on a body picks him for the pass or the switch', () => {
    const { s, mate } = dblScene(12);
    const r = rig(s, mate.pos);
    // Main: the cursor jumped to a body's feet whenever the pointer crossed one (or your own player).
    for (const at of [{ x: 25, y: 30 }, { x: 26, y: 31 }, { x: 27.5, y: 32.2 }]) {
      r.move(at);
      expect(dist(r.input.cursor!, at)).toBeLessThan(1e-9);
    }
    expect(r.picks.length).toBe(0);
    // A left press with the ball, on the team-mate's head 3 m up-screen of his feet: the pass goes to his feet.
    const head = { x: mate.pos.x, y: mate.pos.y - 3 };
    r.move(head);
    r.down(head);
    r.up(head);
    const kick = r.input.take();
    expect(kick.pass).toBe(true);
    expect(dist(kick.aim!, mate.pos)).toBeLessThan(1e-9);
    expect(dist(r.input.cursor!, head)).toBeLessThan(1e-9); // the steering cursor is still the grass
    expect(r.picks).toEqual(['mates']);
    r.input.dispose();
  });

  test('a right press without the ball picks an opponent; with the ball (a shot) nothing is picked', () => {
    const { s } = dblScene(12);
    const opp = role(s, 1, 'MID');
    const r = rig(s, opp.pos);
    s.ball.owner = -1;
    const at = { x: opp.pos.x, y: opp.pos.y - 2 };
    r.move(at);
    r.down(at, 2);
    const t = r.input.take();
    expect(t.tackle).toBe(true);
    expect(dist(t.aim!, opp.pos)).toBeLessThan(1e-9);
    expect(r.picks).toEqual(['opponents']);
    r.input.dispose();
  });

  test('the man you steer is never pickable; team-mates and opponents are by side', () => {
    const s = livePlay();
    const me = s.controlled[0];
    const mates = pickable(s, 0, 'mates');
    const opps = pickable(s, 0, 'opponents');
    expect(mates[me]).toBe(false);
    expect(opps[me]).toBe(false);
    for (const p of s.players) {
      if (p.i === me) continue;
      expect(mates[p.i]).toBe(p.team === 0);
      expect(opps[p.i]).toBe(p.team === 1);
    }
  });
});
