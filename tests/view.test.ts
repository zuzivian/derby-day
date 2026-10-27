// The view stream's pure parts: instant-replay highlights and the snapshot buffer, the power
// gauge shared by the aim wedge and the HUD bar, the long view, and the broadcast framing.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { HighlightSpotter, ReplayBuffer, SNAP_EVERY, BUFFER_TICKS, cloneState, type Highlight } from '../src/client/highlights.ts';
import { goalCross, loftGauge, passGauge, shotGauge, shotGoalCross, kickGauge, SHOT_SWEET, SHOT_WILD } from '../src/client/power.ts';
import { WEDGE_MAX } from '../src/client/r3d/aim3d.ts';
import { BROADCAST_WIDTH, MatchCamera, ZOOM_MAX, ZOOM_MIN, clampZoom } from '../src/client/r3d/camera3d.ts';
import { longView, penaltyView } from '../src/client/r3d/renderer3d.ts';
import { Plane, Raycaster, Vector2, Vector3 } from '../src/client/r3d/three.ts';
import { GOAL_W, PITCH_H, PITCH_W } from '../src/sim/constants.ts';
import { HUMAN_SHOT_MIN } from '../src/sim/kicks.ts';
import { createMatch, fingerprint, step } from '../src/sim/match.ts';
import type { HumanInput, MatchState } from '../src/sim/types.ts';
import { kickOff } from './helpers.ts';

function match(seed: number, humans: [boolean, boolean] = [true, false]): MatchState {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return createMatch({ seed, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds: 180, humans });
}

/** A scripted human: wanders the pointer, passes and shoots now and then. */
function human(t: number): HumanInput {
  const i: HumanInput = { cursor: { x: 50 + 30 * Math.sin(t / 80), y: 34 + 18 * Math.cos(t / 65) } };
  if (t % 90 === 0) i.pass = true;
  if (t % 400 === 0) i.shoot = 0.7;
  return i;
}

describe('instant replays: the snapshot buffer', () => {
  test('re-creates any tick in the window exactly, without touching the live match', () => {
    const s = match(3);
    const buf = new ReplayBuffer(s);
    for (let t = 1; t <= 2400; t++) {
      const inp = human(t);
      step(s, inp);
      buf.push(inp, s);
    }
    const liveBefore = fingerprint(s);
    expect(buf.latest).toBe(s.tick);
    expect(buf.earliest).toBeLessThanOrEqual(s.tick - BUFFER_TICKS + SNAP_EVERY);
    // Start a "replay" a few seconds back and run it to the live tick: it must land on the same state.
    for (const back of [30, 241, 600, BUFFER_TICKS - SNAP_EVERY]) {
      const r = buf.open(s.tick - back);
      expect(r.state.tick).toBe(s.tick - back);
      while (r.step()) {}
      expect(r.state.tick).toBe(s.tick);
      expect(fingerprint(r.state)).toBe(liveBefore);
    }
    expect(fingerprint(s)).toBe(liveBefore);
    // And the live match carries on as if nothing happened: same as a match that never replayed.
    const twin = match(3);
    for (let t = 1; t <= 2700; t++) step(twin, human(t));
    for (let t = 2401; t <= 2700; t++) step(s, human(t));
    expect(fingerprint(s)).toBe(fingerprint(twin));
  });

  test('a clone is a deep copy', () => {
    const s = match(4);
    const c = cloneState(s);
    c.ball.pos.x += 10;
    c.players[0].pos.y += 3;
    c.rng.s += 1;
    expect(s.ball.pos.x).not.toBe(c.ball.pos.x);
    expect(s.players[0].pos.y).not.toBe(c.players[0].pos.y);
    expect(s.rng.s).not.toBe(c.rng.s);
  });

  test('keeps memory bounded: about BUFFER_TICKS of snapshots', () => {
    const s = match(5, [false, false]);
    const buf = new ReplayBuffer(s);
    for (let t = 0; t < 5000; t++) {
      step(s);
      buf.push(undefined, s);
    }
    const snaps = (buf as unknown as { snaps: unknown[] }).snaps.length;
    expect(snaps).toBeLessThanOrEqual(BUFFER_TICKS / SNAP_EVERY + 2);
    expect(s.tick - buf.earliest).toBeLessThanOrEqual(BUFFER_TICKS + SNAP_EVERY);
  });
});

describe('instant replays: spotting highlights', () => {
  test('CPU matches: every goal is spotted, saves and near misses are found, not every shot is a highlight', () => {
    const tally: Record<string, number> = {};
    let goals = 0;
    let shots = 0;
    for (let m = 0; m < 4; m++) {
      const s = match(40 + m, [false, false]);
      const sp = new HighlightSpotter(s);
      const found: Highlight[] = [];
      while (s.phase !== 'fulltime') {
        step(s);
        found.push(...sp.update(s));
      }
      for (const h of found) {
        tally[h.kind] = (tally[h.kind] ?? 0) + 1;
        expect(h.goalX === 0 || h.goalX === PITCH_W).toBe(true);
        expect(h.label.length).toBeGreaterThan(3);
      }
      goals += s.score[0] + s.score[1];
      shots += s.stats[0].shots + s.stats[1].shots;
      expect(found.filter((h) => h.kind === 'goal').length).toBe(s.score[0] + s.score[1]);
    }
    expect(goals).toBeGreaterThan(0);
    expect(tally.save ?? 0).toBeGreaterThan(0);
    const nonGoal = (tally.save ?? 0) + (tally.miss ?? 0) + (tally.woodwork ?? 0);
    expect(nonGoal).toBeLessThan(shots - goals);
  });

  test('a shot off the post is the woodwork, one just wide is a near miss', () => {
    for (const [y, kind] of [
      [PITCH_H / 2 - 3.66 - 0.05, 'woodwork'],
      [PITCH_H / 2 + 3.66 + 0.3, 'miss'],
    ] as const) {
      const s = match(9, [false, false]);
      for (let t = 0; t < 300; t++) step(s);
      const sp = new HighlightSpotter(s);
      const shooter = s.players.find((p) => p.team === 0 && p.role !== 'GK')!;
      const keeper = s.players.find((p) => p.team === 1 && p.role === 'GK')!;
      keeper.pos = { x: PITCH_W - 1, y: PITCH_H / 2 + (kind === 'miss' ? -3 : 3) };
      const b = s.ball;
      b.owner = -1;
      b.pos = { x: PITCH_W - 12, y };
      b.vel = { x: 25, y: 0 };
      b.z = 0.3;
      b.vz = 0;
      b.lastTouch = shooter.i;
      s.stats[0].shots++;
      const found: Highlight[] = [];
      for (let t = 0; t < 90; t++) {
        step(s);
        found.push(...sp.update(s));
      }
      expect(found.map((h) => h.kind)).toContain(kind);
    }
  });

  test('a card is replayed from the foul behind it', () => {
    const s = match(11, [false, false]);
    const sp = new HighlightSpotter(s);
    let card: Highlight | null = null;
    for (let t = 0; t < 60 * 360 && !card; t++) {
      step(s);
      card = sp.update(s).find((h) => h.kind === 'yellow' || h.kind === 'red') ?? null;
    }
    if (!card) return; // no booking in this match: nothing to check
    const ev = s.events.filter((e) => e.kind === 'card').at(-1)!;
    expect(card.tick).toBeLessThanOrEqual(ev.tick);
  });
});

describe('power gauge', () => {
  test('shots: green to the sweet spot, amber, then red when over-hit', () => {
    expect(shotGauge(0.55).band).toBe('green');
    expect(shotGauge(SHOT_SWEET - 0.01).band).toBe('green');
    expect(shotGauge(SHOT_SWEET + 0.02).band).toBe('amber');
    expect(shotGauge(SHOT_WILD + 0.02).band).toBe('red');
    expect(shotGauge(1).fill).toBe(1);
    expect(shotGauge(0.7).fill).toBeCloseTo(0.7, 5);
  });

  test('passes: the pace of the click, green for a normal pass, red for a thrashed one', () => {
    expect(passGauge(11).band).toBe('green');
    expect(passGauge(20).band).toBe('amber');
    expect(passGauge(27).band).toBe('red');
    expect(passGauge(14).fill).toBeLessThan(passGauge(22).fill);
  });

  test('lofts: amber while it would fall short of the pointer, green once it reaches', () => {
    expect(loftGauge(0.1, 15, 30).band).toBe('amber');
    expect(loftGauge(0.7, 31, 30).band).toBe('green');
  });

  test('the live gauge follows the plain click pass and the charge', () => {
    const s = match(12);
    for (let t = 0; t < 200; t++) step(s, {});
    const me = s.players[s.controlled[0]];
    me.pos = { x: 50, y: 34 };
    s.ball.pos = { x: 50.5, y: 34 };
    s.ball.owner = me.i;
    s.ball.vel = { x: 0, y: 0 };
    s.ball.z = 0;
    // A click is always a pass to a teammate: one 8 m off, one 35 m off, the pointer on each.
    const [a, b] = s.players.filter((p) => p.team === 0 && p.role !== 'GK' && p.i !== me.i);
    a.pos = { x: 58, y: 34 };
    b.pos = { x: 85, y: 34 };
    a.vel = b.vel = { x: 0, y: 0 };
    const near = kickGauge(s, { cursor: { ...a.pos }, charge: 0, showCursor: true })!;
    const far = kickGauge(s, { cursor: { ...b.pos }, charge: 0, showCursor: true })!;
    expect(near.fill).toBeLessThan(far.fill);
    expect(near.band).toBe('green');
    const shot = kickGauge(s, { cursor: { x: 90, y: 34 }, charge: 0.9, showCursor: true, armed: { kind: 'shot', power: 0.98 } })!;
    expect(shot.band).toBe('red');
    s.ball.owner = -1;
    expect(kickGauge(s, { cursor: { x: 90, y: 34 }, charge: 0, showCursor: true })).toBe(null);
  });
});

describe('shot crosshair on the goal face', () => {
  const mid = PITCH_H / 2;
  test('sits where the line from the ball through the pointer crosses the goal line', () => {
    // Pointer on the grass 10 m short of the line, 2 m off centre: the line carries on to 5 m off centre.
    const c = goalCross({ x: 80, y: mid }, { x: 90, y: mid + 2 }, PITCH_W, HUMAN_SHOT_MIN, 0.7)!;
    expect(c.y).toBeCloseTo(mid + 5, 6);
    expect(c.d).toBeCloseTo(Math.hypot(25, 5), 6);
    // Wide of the post by 1.3 m: still drawn, but not in the mouth.
    expect(c.inMouth).toBe(false);
    const centre = goalCross({ x: 80, y: mid }, { x: 90, y: mid + 1 }, PITCH_W, HUMAN_SHOT_MIN, 0.7)!;
    expect(centre.y).toBeCloseTo(mid + 2.5, 6);
    expect(centre.inMouth).toBe(true);
    // Their goal at x = 0 as well.
    const left = goalCross({ x: 20, y: mid }, { x: 10, y: mid - 2 }, 0, HUMAN_SHOT_MIN, 0.7)!;
    expect(left.y).toBeCloseTo(mid - 4, 6);
  });

  test('rises with the power, as the sim plans it', () => {
    const from = { x: 90, y: mid };
    const to = { x: 100, y: mid };
    const click = goalCross(from, to, PITCH_W, HUMAN_SHOT_MIN, 0.7)!;
    const full = goalCross(from, to, PITCH_W, 1, 0.7)!;
    expect(click.z).toBeLessThan(0.7);
    expect(full.z).toBeGreaterThan(1.4);
    expect(full.z).toBeLessThan(2.3);
  });

  test('hidden when the line heads away, misses by a lot, or is too far', () => {
    expect(goalCross({ x: 80, y: mid }, { x: 70, y: mid }, PITCH_W, 0.8, 0.7)).toBe(null);
    expect(goalCross({ x: 80, y: mid }, { x: 90, y: mid + 5 }, PITCH_W, 0.8, 0.7)).toBe(null);
    expect(goalCross({ x: 50, y: mid }, { x: 60, y: mid }, PITCH_W, 0.8, 0.7)).toBe(null);
    // A line along the goal line never crosses it.
    expect(goalCross({ x: 80, y: 10 }, { x: 80, y: 40 }, PITCH_W, 0.8, 0.7)).toBe(null);
    expect(GOAL_W).toBeGreaterThan(7);
  });

  test('the live shot: open play only, not for the keeper, and kicks by the ball go the way he faces', () => {
    const s = match(12);
    for (let t = 0; t < 200; t++) step(s, {});
    const me = s.players[s.controlled[0]];
    me.pos = { x: 80, y: mid };
    me.facing = { x: 1, y: 0 };
    s.ball.pos = { x: 80.5, y: mid };
    s.ball.owner = me.i;
    s.ball.z = 0;
    s.phase = 'play';
    const c = shotGoalCross(s, me, { x: 95, y: mid }, 0.8)!;
    expect(c.y).toBeCloseTo(mid, 6);
    // A pointer by the ball has no direction: it goes the way he faces, 20 m on.
    expect(shotGoalCross(s, me, { x: 80, y: mid + 1 }, 0.8)!.y).toBeCloseTo(mid, 6);
    s.phase = 'restart';
    expect(shotGoalCross(s, me, { x: 95, y: mid }, 0.8)).toBe(null);
  });

  test('the wedge is drawn short: a gauge, not a ruler', () => {
    expect(WEDGE_MAX).toBeGreaterThanOrEqual(5);
    expect(WEDGE_MAX).toBeLessThanOrEqual(8);
  });
});

describe('camera', () => {
  const rc = new Raycaster();
  const ground = new Plane(new Vector3(0, 1, 0), 0);
  const across = (c: MatchCamera, ny: number) => {
    const hit = new Vector3();
    rc.setFromCamera(new Vector2(-1, ny), c.camera);
    rc.ray.intersectPlane(ground, hit);
    const l = hit.x;
    rc.setFromCamera(new Vector2(1, ny), c.camera);
    rc.ray.intersectPlane(ground, hit);
    return hit.x - l;
  };
  const focus = { x: 0, z: 0, vx: 0, vz: 0, air: 0, attack: 0, phase: 'play', close: null, humanDir: 1 as const };
  const settle = (c: MatchCamera, f = focus, aspect = 1.5, w = 1040) => {
    for (let i = 0; i < 400; i++) c.update(1 / 60, f, aspect, w, false);
    return new Vector3(f.x, 0, f.z).project(c.camera).y;
  };

  test('the broadcast view shows 45-60 m across at the ball on a desktop window', () => {
    const c = new MatchCamera();
    const y = settle(c);
    const w = across(c, y);
    expect(w).toBeGreaterThan(45);
    expect(w).toBeLessThan(60);
    expect(BROADCAST_WIDTH).toBeGreaterThan(40);
  });

  test('zoom widens and narrows the frame within its limits', () => {
    const wide = new MatchCamera();
    wide.zoom = ZOOM_MAX;
    const tight = new MatchCamera();
    tight.zoom = ZOOM_MIN;
    expect(across(wide, settle(wide))).toBeGreaterThan(across(tight, settle(tight)) * 2);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  test('a still pointer stays on the same grass while the carrier weaves on the spot (dead zone)', () => {
    const c = new MatchCamera();
    let f = { ...focus, x: -20, z: 5 };
    settle(c, f);
    const hit = new Vector3();
    const point = () => {
      rc.setFromCamera(new Vector2(0.3, -0.2), c.camera);
      rc.ray.intersectPlane(ground, hit);
      return hit.clone();
    };
    const p0 = point();
    for (let i = 0; i < 240; i++) {
      const t = i / 60;
      f = { ...f, z: 5 + 1.5 * Math.sin(t * 2.5), vz: 3.75 * Math.cos(t * 2.5) };
      c.update(1 / 60, f, 1.5, 1040, false);
    }
    expect(point().distanceTo(p0)).toBeLessThan(0.5);
  });

  // Red-team round 1: an own-half free kick near the near touchline put the ball and the taker
  // off-screen, and every desktop long view lost the near-side teammates under the frame.
  test('the long view keeps the ball, both touchlines and 20 m past halfway in shot, on every screen shape', () => {
    const spots: [string, number, number][] = [['goalkick', 5.5, 24.84], ['goalkick', 5.5, 43.16]];
    for (let y = 5; y <= 63; y += 6) for (const x of [12, 30, 45]) spots.push(['freekick', x, y]);
    for (const [aspect, w] of [
      [1041 / 697, 1041],
      [358 / 448, 358],
      [358 / 597, 358],
      [828 / 374, 828],
      [1900 / 1000, 1900],
    ]) {
      for (const [kind, x, y] of spots) {
        const s = match(14);
        s.restart = { kind, team: 0, spot: { x, y }, stage: 'ready' } as MatchState['restart'];
        const lv = longView(s, 0)!;
        expect(lv).not.toBe(null);
        const c = new MatchCamera();
        const f = { ...focus, x: x - PITCH_W / 2, z: y - PITCH_H / 2, long: { points: lv.points.map((p) => ({ x: p.x - PITCH_W / 2, z: p.y - PITCH_H / 2 })) } };
        for (let i = 0; i < 400; i++) c.update(1 / 60, f, aspect, w, false);
        // The ball, the corners of the strip (touchline to touchline, from behind the ball to 20 m past
        // halfway), and a full-back on each touchline level with the ball.
        // On upright screens only a band 20 m either side of the ball across the pitch (NARROW_BAND).
        const band = (q: { x: number; y: number }) => (aspect < 1 ? { x: Math.max(x - 56, Math.min(x + 56, q.x)), y: Math.max(y - 20, Math.min(y + 20, q.y)) } : q);
        const must = [{ x, y }, ...[...lv.points, { x: x + 8, y: 64 }, { x: x + 8, y: 4 }].map(band)];
        for (const p of must) {
          const v = new Vector3(p.x - PITCH_W / 2, 0, p.y - PITCH_H / 2).project(c.camera);
          const ok = Math.abs(v.x) <= 0.9 && Math.abs(v.y) <= 0.9;
          if (!ok) throw new Error(`${kind} at ${x},${y}, aspect ${aspect.toFixed(2)}: (${p.x},${p.y}) at ndc ${v.x.toFixed(2)},${v.y.toFixed(2)}`);
        }
        expect(lv.points.some((p) => p.x >= PITCH_W / 2 + 20)).toBe(true);
      }
    }
  });

  test('a corner frames the taker, the goal and the whole box, for either side and at either end', () => {
    for (const [aspect, w] of [
      [1041 / 697, 1041],
      [358 / 597, 358],
      [828 / 374, 828],
    ]) {
      for (const [team, cx, cy] of [
        [0, PITCH_W, 0],
        [0, PITCH_W, PITCH_H],
        [1, 0, 0],
        [1, 0, PITCH_H],
      ] as const) {
        const s = match(15);
        s.restart = { kind: 'corner', team, spot: { x: cx, y: cy }, stage: 'ready' } as MatchState['restart'];
        const lv = longView(s, 0)!;
        expect(lv.kind).toBe('corner');
        const c = new MatchCamera();
        const f = { ...focus, x: cx - PITCH_W / 2, z: cy - PITCH_H / 2, long: { points: lv.points.map((p) => ({ x: p.x - PITCH_W / 2, z: p.y - PITCH_H / 2 })), corner: true } };
        for (let i = 0; i < 400; i++) c.update(1 / 60, f, aspect, w, false);
        const gx = cx === 0 ? 0 : PITCH_W;
        const box = cx === 0 ? 16.5 : PITCH_W - 16.5;
        for (const p of [{ x: cx, y: cy }, { x: gx, y: PITCH_H / 2 - 3.66 }, { x: gx, y: PITCH_H / 2 + 3.66 }, { x: box, y: PITCH_H / 2 - 20.16 }, { x: box, y: PITCH_H / 2 + 20.16 }]) {
          const v = new Vector3(p.x - PITCH_W / 2, 0, p.y - PITCH_H / 2).project(c.camera);
          if (Math.abs(v.x) > 0.9 || Math.abs(v.y) > 0.9) throw new Error(`corner ${cx},${cy} aspect ${aspect.toFixed(2)}: (${p.x},${p.y}) at ${v.x.toFixed(2)},${v.y.toFixed(2)}`);
        }
      }
    }
  });

  // Penalty camera: the broadcast view showed the goal edge on (a 43 px tall mouth on an upright
  // phone, 96 px at 1280x800); now from behind the spot, face on, with the taker below the goal mouth.
  test('a penalty is seen from behind the spot: the whole goal face on, the taker and his marker below it, keys aim at the goal', () => {
    for (const [aspect, w] of [
      [1010 / 677, 1010],
      [358 / 636, 358],
      [828 / 374, 828],
    ]) {
      for (const d of [1, -1] as const) {
        const spot = { x: d * (PITCH_W / 2 - 11), z: 0 };
        const gx = d * (PITCH_W / 2);
        const c = new MatchCamera();
        const f = { ...focus, x: spot.x, z: spot.z, phase: 'restart', penalty: { x: spot.x, z: spot.z, goalX: gx } };
        for (let i = 0; i < 400; i++) c.update(1 / 60, f, aspect, w, false);
        // Behind the spot, on the line through it to the goal.
        expect((c.camera.position.x - spot.x) * d).toBeLessThan(0);
        expect(Math.abs(c.camera.position.z)).toBeLessThan(1e-6);
        const ndc = (x: number, y: number, z: number) => new Vector3(x, y, z).project(c.camera);
        for (const z of [-3.66, 3.66]) {
          for (const y of [0, 2.44]) {
            const v = ndc(gx, y, z);
            if (Math.abs(v.x) > 0.9 || Math.abs(v.y) > 0.9) throw new Error(`penalty ${d} aspect ${aspect.toFixed(2)}: post (${z}, ${y}) at ${v.x.toFixed(2)},${v.y.toFixed(2)}`);
          }
        }
        // The goal mouth is wide on screen: a third of the frame at least (of a 3:2 frame, on a wider
        // screen, which shows the same with more either side).
        expect((Math.abs(ndc(gx, 0, 3.66).x - ndc(gx, 0, -3.66).x) / 2) * Math.max(1, aspect / 1.5)).toBeGreaterThan(0.33);
        // The taker, his feet in shot and his marker (about 3.1 m up) below the goal line.
        const behind = spot.x - d * 0.5;
        expect(ndc(behind, 3.1, 0).y).toBeLessThan(ndc(gx, 0, 0).y);
        expect(ndc(behind, 0, 0).y).toBeGreaterThan(-0.9);
        // Keys: screen up runs toward the goal, screen right to the taker's right.
        const k = (v: { x: number; y: number }) => ({ x: v.x + 0, y: v.y + 0 });
        expect(k(c.screenDir({ x: 0, y: -1 }, 1))).toEqual({ x: d, y: 0 });
        expect(k(c.screenDir({ x: 1, y: 0 }, 1))).toEqual({ x: 0, y: d });
        // And back to the broadcast view after: from the long side, keys as on screen.
        const g = { ...f, phase: 'play', penalty: null };
        for (let i = 0; i < 60; i++) c.update(1 / 60, g, aspect, w, false);
        expect(c.camera.position.z).toBeGreaterThan(10);
        expect(k(c.screenDir({ x: 0, y: -1 }, 1))).toEqual({ x: 0, y: -1 });
      }
    }
  });

  test('penaltyView: a penalty being set up or taken, for either side, not while the ball is still dead', () => {
    const s = match(17);
    s.restart = { kind: 'penalty', team: 0, spot: { x: PITCH_W - 11, y: PITCH_H / 2 }, stage: 'ready' } as MatchState['restart'];
    expect(penaltyView(s)).toEqual({ spot: { x: PITCH_W - 11, y: PITCH_H / 2 }, goalX: PITCH_W });
    s.restart = { kind: 'penalty', team: 1, spot: { x: 11, y: PITCH_H / 2 }, stage: 'setup' } as MatchState['restart'];
    expect(penaltyView(s)).toEqual({ spot: { x: 11, y: PITCH_H / 2 }, goalX: 0 });
    s.restart = { kind: 'penalty', team: 1, spot: { x: 11, y: PITCH_H / 2 }, stage: 'whistle' } as MatchState['restart'];
    expect(penaltyView(s)).toBe(null);
    s.restart = { kind: 'freekick', team: 0, spot: { x: 80, y: PITCH_H / 2 }, stage: 'ready' } as MatchState['restart'];
    expect(penaltyView(s)).toBe(null);
  });

  // Set-piece camera: from 24 m out wide, or 35 m out, the broadcast view lost the goal (both posts
  // off the edge at 1280x800; at 35 m on a phone too).
  test('a free kick in the attacking half frames the ball, the run-up, the wall and the goal, for either side', () => {
    for (const [aspect, w] of [
      [1041 / 697, 1041],
      [358 / 636, 358],
      [358 / 448, 358],
      [828 / 374, 828],
    ]) {
      for (const team of [0, 1] as const) {
        for (const [d, y] of [[22, 34], [24, 14], [24, 54], [35, 30], [30, 6], [45, 34]]) {
          const s = match(16);
          // Team 0 attacks x = PITCH_W in the first half, team 1 x = 0.
          const gx = team === 0 ? PITCH_W : 0;
          const x = team === 0 ? PITCH_W - d : d;
          s.restart = { kind: 'freekick', team, spot: { x, y }, stage: 'ready' } as MatchState['restart'];
          const lv = longView(s, 0)!;
          expect(lv.kind).toBe('setpiece');
          const c = new MatchCamera();
          const f = { ...focus, x: x - PITCH_W / 2, z: y - PITCH_H / 2, long: { points: lv.points.map((p) => ({ x: p.x - PITCH_W / 2, z: p.y - PITCH_H / 2 })), corner: true } };
          for (let i = 0; i < 400; i++) c.update(1 / 60, f, aspect, w, false);
          const l = Math.hypot(gx - x, PITCH_H / 2 - y);
          const [ux, uy] = [(gx - x) / l, (PITCH_H / 2 - y) / l];
          const must = [
            { x, y },
            { x: x - ux * 2, y: y - uy * 2 },
            { x: x + ux * 9.15 - uy * 2.5, y: y + uy * 9.15 + ux * 2.5 },
            { x: x + ux * 9.15 + uy * 2.5, y: y + uy * 9.15 - ux * 2.5 },
            { x: gx, y: PITCH_H / 2 - 3.66 },
            { x: gx, y: PITCH_H / 2 + 3.66 },
          ];
          for (const p of must) {
            const v = new Vector3(p.x - PITCH_W / 2, 0, p.y - PITCH_H / 2).project(c.camera);
            if (Math.abs(v.x) > 0.9 || Math.abs(v.y) > 0.9) throw new Error(`free kick ${team} at ${x},${y}, aspect ${aspect.toFixed(2)}: (${p.x.toFixed(1)},${p.y.toFixed(1)}) at ndc ${v.x.toFixed(2)},${v.y.toFixed(2)}`);
          }
        }
      }
    }
    // In the taking side's own half it stays the long view (the human's), or none (the CPU's).
    const s = match(16);
    s.restart = { kind: 'freekick', team: 0, spot: { x: 40, y: 30 }, stage: 'ready' } as MatchState['restart'];
    expect(longView(s, 0)!.kind).toBe('long');
    s.restart = { kind: 'freekick', team: 1, spot: { x: 65, y: 30 }, stage: 'ready' } as MatchState['restart'];
    expect(longView(s, 0)).toBe(null);
    // Not while the ball is still rolling dead ('whistle'), and not with two humans on one screen.
    s.restart = { kind: 'freekick', team: 0, spot: { x: 83, y: 34 }, stage: 'whistle' } as MatchState['restart'];
    expect(longView(s, 0)).toBe(null);
    const hs = match(16, [true, true]);
    hs.restart = { kind: 'freekick', team: 0, spot: { x: 83, y: 34 }, stage: 'ready' } as MatchState['restart'];
    expect(longView(hs, 0)).toBe(null);
  });

  test('a portrait phone shows at least 40 m across at the ball', () => {
    const c = new MatchCamera();
    const y = settle(c, focus, 0.8, 358);
    expect(across(c, y)).toBeGreaterThan(40);
  });

  test('long view: goal kicks and the keeper holding the ball, for the human side only', () => {
    const s = match(13);
    kickOff(s);
    for (let t = 0; t < 250; t++) step(s, {});
    expect(longView(s, 0)).toBe(null);
    // The ball goes out over the human's goal line off an opponent: a goal kick.
    const away = s.players.find((p) => p.team === 1 && p.role !== 'GK')!;
    const b = s.ball;
    b.owner = -1;
    b.pos = { x: 1.5, y: 18 };
    b.vel = { x: -16, y: 0 };
    b.z = 0;
    b.lastTouch = away.i;
    let seen: ReturnType<typeof longView> = null;
    for (let t = 0; t < 120 && !seen; t++) {
      step(s, {});
      seen = longView(s, 0);
    }
    expect(seen).not.toBe(null);
    // It frames the ball and the strip out to 20 m past halfway.
    expect(seen!.points.length).toBeGreaterThan(3);
    expect(Math.max(...seen!.points.map((p) => p.x))).toBeGreaterThanOrEqual(PITCH_W / 2 + 20);
    expect(seen!.points[0]).toEqual(seen!.ball);
    expect(longView(s, 1)).toBe(null);
    // It holds for as long as the restart waits on the taker (every tick of 'setup' and 'ready'),
    // so once humans take their own goal kicks it stays up until they kick.
    let waiting = 0;
    for (let t = 0; t < 600 && s.restart?.kind === 'goalkick'; t++) {
      if (s.restart.stage !== 'whistle') {
        waiting++;
        expect(longView(s, 0)).not.toBe(null);
      }
      step(s, {});
    }
    expect(waiting).toBeGreaterThan(20);
    // Two humans on one screen: no long view (one camera for both).
    const hs = match(13, [true, true]);
    expect(longView(hs, 0)).toBe(null);
  });
});
