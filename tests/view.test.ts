// The view stream's pure parts: instant-replay highlights and the snapshot buffer, the power
// gauge shared by the aim wedge and the HUD bar, the long view, and the broadcast framing.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { HighlightSpotter, ReplayBuffer, SNAP_EVERY, BUFFER_TICKS, cloneState, type Highlight } from '../src/client/highlights.ts';
import { loftGauge, passGauge, shotGauge, kickGauge, SHOT_SWEET, SHOT_WILD } from '../src/client/power.ts';
import { BROADCAST_WIDTH, MatchCamera, ZOOM_MAX, ZOOM_MIN, clampZoom } from '../src/client/r3d/camera3d.ts';
import { longView } from '../src/client/r3d/renderer3d.ts';
import { Plane, Raycaster, Vector2, Vector3 } from '../src/client/r3d/three.ts';
import { PITCH_H, PITCH_W } from '../src/sim/constants.ts';
import { createMatch, fingerprint, step } from '../src/sim/match.ts';
import type { HumanInput, MatchState } from '../src/sim/types.ts';

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
    const near = kickGauge(s, { cursor: { x: 58, y: 34 }, charge: 0, showCursor: true })!;
    const far = kickGauge(s, { cursor: { x: 90, y: 34 }, charge: 0, showCursor: true })!;
    expect(near.fill).toBeLessThan(far.fill);
    expect(near.band).toBe('green');
    const shot = kickGauge(s, { cursor: { x: 90, y: 34 }, charge: 0.9, showCursor: true, armed: { kind: 'shot', power: 0.98 } })!;
    expect(shot.band).toBe('red');
    s.ball.owner = -1;
    expect(kickGauge(s, { cursor: { x: 90, y: 34 }, charge: 0, showCursor: true })).toBe(null);
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

  test('the long view reaches past halfway on desktop and on a portrait phone', () => {
    for (const [aspect, w] of [
      [1.5, 1040],
      [0.8, 358],
    ]) {
      const c = new MatchCamera();
      const kx = -PITCH_W / 2 + 6;
      const f = { ...focus, x: kx, long: { x: kx + 90 * 0.32, z: 0, width: 90 } };
      for (let i = 0; i < 400; i++) c.update(1 / 60, f, aspect, w, false);
      const y = new Vector3(kx, 0, 0).project(c.camera).y;
      const hit = new Vector3();
      rc.setFromCamera(new Vector2(1, y), c.camera);
      rc.ray.intersectPlane(ground, hit);
      expect(hit.x).toBeGreaterThan(12); // scene x 0 is halfway
      rc.setFromCamera(new Vector2(-1, y), c.camera);
      rc.ray.intersectPlane(ground, hit);
      expect(hit.x).toBeLessThan(kx); // and the keeper is in shot
    }
  });

  test('a portrait phone shows at least 40 m across at the ball', () => {
    const c = new MatchCamera();
    const y = settle(c, focus, 0.8, 358);
    expect(across(c, y)).toBeGreaterThan(40);
  });

  test('long view: goal kicks and the keeper holding the ball, for the human side only', () => {
    const s = match(13);
    for (let t = 0; t < 300; t++) step(s, {});
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
    expect(seen!.width).toBeGreaterThanOrEqual(85);
    // Centred upfield of the goal area, so the frame runs well past halfway.
    expect(seen!.x + seen!.width / 2).toBeGreaterThan(PITCH_W / 2 + 15);
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
