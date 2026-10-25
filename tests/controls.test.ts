// The pointer controls: what the sim does with cursor, pass, loft, shoot, tackle and select.
// (Input timing, hold-to-power mapping and the DOM live in src/client/input.ts and are driven in the e2e tests.)

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { encodeReplay, decodeReplay, finalHash, replayTo, ReplayRecorder } from '../src/meta/replay.ts';
import { PITCH_H, PITCH_W, SPRINT_MULT } from '../src/sim/constants.ts';
import { humanIntent, pickTeammate, pointerEffort, pointerThrottle, POINTER_DEAD, POINTER_JOG, POINTER_JOG_AT, POINTER_RUN_AT, POINTER_SPRINT_AT, PICK_R, POINTER_WALK, SELECT_R, SLIDE_MAX, STAND_TACKLE_R } from '../src/sim/human.ts';
import { assistRadius, groundPassPlan, loftPlan, loftRange, pointerPass } from '../src/sim/kicks.ts';
import { createMatch, fingerprint, step } from '../src/sim/match.ts';
import type { HumanInput, MatchPlayer, MatchState } from '../src/sim/types.ts';
import { dist, len, norm, sub, type Vec } from '../src/sim/vec.ts';
import { kickOff } from './helpers.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

function livePlay(seed = 5): MatchState {
  const s = createMatch({ seed, ...teams(7), halfSeconds: 60 });
  kickOff(s);
  return s;
}

/** Everyone but `keep` is on the floor, so nothing interferes and control stays put. */
function isolate(s: MatchState, ...keep: MatchPlayer[]): void {
  for (const p of s.players) if (!keep.includes(p)) p.stun = 100000;
}

/** The human with the ball in open space at a known spot, everyone else out of the way. */
function carrier(at: Vec = { x: 20, y: 20 }): { s: MatchState; me: MatchPlayer } {
  const s = livePlay();
  const me = s.players[s.controlled[0]];
  isolate(s, me);
  s.switchTimer[0] = 1e9; // no auto-switch away from him
  me.pos = { ...at };
  me.vel = { x: 0, y: 0 };
  me.facing = { x: 1, y: 0 };
  s.ball.pos = { x: at.x + 0.99, y: at.y };
  s.ball.vel = { x: 0, y: 0 };
  return { s, me };
}

/** Put the ball with an opponent so the human's team does not have it and control is manual. */
function oppHasBall(s: MatchState): MatchPlayer {
  const opp = s.players.find((p) => p.team === 1 && p.role === 'MID')!;
  s.ball.owner = opp.i;
  s.ball.receiver = -1;
  s.ball.lastTouch = opp.i;
  s.ball.pos = { ...opp.pos };
  s.ball.vel = { x: 0, y: 0 };
  return opp;
}

describe('pointer distance sets speed', () => {
  test('the curve: a 0.6 m dead zone, a walk, a jog at 4 m, a run at 8 m, a full sprint from 11 m', () => {
    expect(POINTER_DEAD).toBe(0.6);
    expect(pointerEffort(0)).toBe(0);
    expect(pointerEffort(POINTER_DEAD)).toBe(0);
    expect(pointerEffort(POINTER_DEAD + 0.01)).toBeCloseTo(POINTER_WALK, 1);
    expect(pointerEffort(POINTER_JOG_AT)).toBeCloseTo(POINTER_JOG, 5);
    expect(pointerEffort(POINTER_RUN_AT)).toBeCloseTo(1, 5);
    expect(pointerEffort(POINTER_SPRINT_AT)).toBeCloseTo(SPRINT_MULT, 5);
    // Sprint to jog is about 2:1 (research: about 2.5:1).
    expect(SPRINT_MULT / POINTER_JOG).toBeGreaterThan(2);
    expect(pointerEffort(40)).toBe(SPRINT_MULT);
    let prev = 0;
    for (let d = 0; d <= 20; d += 0.1) {
      const e = pointerEffort(d);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });

  test('sprint starts above normal top speed, and the speed asked for is continuous across it', () => {
    let lastSpeed = pointerEffort(0.65);
    for (let d = 0.65; d <= 14; d += 0.05) {
      const { throttle, sprint } = pointerThrottle(d);
      const asked = throttle * (sprint ? SPRINT_MULT : 1);
      expect(asked).toBeCloseTo(pointerEffort(d), 9);
      expect(asked - lastSpeed).toBeLessThan(0.02);
      lastSpeed = asked;
      expect(sprint).toBe(pointerEffort(d) > 1);
    }
    expect(pointerThrottle(3).sprint).toBe(false);
    expect(pointerThrottle(7.9).sprint).toBe(false);
    expect(pointerThrottle(9).sprint).toBe(true);
  });

  test('in the sim a player runs faster the further the pointer, and only a far pointer sprints and drains stamina', () => {
    const run = (d: number) => {
      const { s, me } = carrier({ x: 8, y: 20 });
      s.ball.owner = -1; // no ball to slow him down
      s.ball.pos = { x: 60, y: 5 };
      s.ball.noPickup.fill(100000);
      let sprinted = 0;
      for (let t = 0; t < 70; t++) {
        step(s, { cursor: { x: me.pos.x + d, y: me.pos.y } });
        if (me.sprinting) sprinted++;
        if (me.pos.x > 50) me.pos.x = 8;
      }
      return { speed: len(me.vel), sprinted, energy: me.energy };
    };
    const speeds = [0.3, 1, 3, 6, 9, 12, 25].map(run);
    expect(speeds[0].speed).toBeLessThan(0.3);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i].speed).toBeGreaterThan(speeds[i - 1].speed - 1e-9);
    const top = speeds[speeds.length - 1].speed;
    // Speed follows pointerEffort(d) / SPRINT_MULT of the sprint speed.
    for (const [i, d] of [1, 3, 6, 9].entries()) expect(speeds[i + 1].speed / top).toBeCloseTo(pointerEffort(d) / SPRINT_MULT, 1);
    expect(speeds[3].sprinted).toBe(0); // 6 m: a jog
    expect(speeds[6].sprinted).toBeGreaterThan(50);
    expect(speeds[6].energy).toBeLessThan(speeds[3].energy);
  });

  test('a winded player cannot sprint however far the pointer is', () => {
    const { s, me } = carrier({ x: 8, y: 20 });
    s.ball.owner = -1;
    s.ball.pos = { x: 60, y: 5 };
    s.ball.noPickup.fill(100000);
    me.energy = 0.4;
    me.winded = true;
    for (let t = 0; t < 60; t++) {
      step(s, { cursor: { x: me.pos.x + 30, y: me.pos.y } });
      expect(me.sprinting).toBe(false);
      if (me.pos.x > 50) me.pos.x = 8;
    }
    const top = 5 + 3.4 * me.attrs.pace;
    expect(len(me.vel)).toBeLessThanOrEqual(top * (0.82 + 0.18 * me.energy) + 1e-3);
  });

  test('keys still run at full pace, and Shift (sprint) works only for them', () => {
    const k = carrier({ x: 8, y: 20 });
    const p = carrier({ x: 8, y: 20 });
    for (const c of [k, p]) {
      c.s.ball.owner = -1;
      c.s.ball.pos = { x: 60, y: 5 };
      c.s.ball.noPickup.fill(100000);
    }
    for (let t = 0; t < 40; t++) {
      step(k.s, { dir: { x: 1, y: 0 }, sprint: true });
      step(p.s, { cursor: { x: 9, y: 20 }, sprint: true }); // pointer 1 m away: sprint is ignored
    }
    expect(k.me.sprinting).toBe(true);
    expect(p.me.sprinting).toBe(false);
    expect(len(p.me.vel)).toBeLessThan(len(k.me.vel) / 2);
  });
});

describe('ground pass goes where the pointer is', () => {
  test('groundPassPlan: the kick speed rolls the ball out to the distance', () => {
    let prev = 0;
    for (const d of [2, 5, 10, 20, 35]) {
      const p = groundPassPlan(d);
      expect(p.speed).toBeGreaterThan(prev);
      prev = p.speed;
    }
  });

  test('a left click into space rolls the ball to the point under the pointer, from 5 to 35 m, in any direction', () => {
    for (const [dx, dy] of [[5, 0], [12, 0], [20, 6], [-14, 3], [8, -12], [30, -4], [-18, -18]]) {
      const { s, me } = carrier({ x: 30, y: 20 });
      const target = { x: 30 + dx, y: 20 + dy };
      step(s, { cursor: target, pass: true });
      me.stun = 100000;
      expect(s.ball.owner).toBe(-1);
      let closest = Infinity;
      for (let t = 0; t < 240; t++) {
        step(s);
        closest = Math.min(closest, dist(s.ball.pos, target));
      }
      // Passes through the point (within a metre and a half), and has stopped not far beyond it.
      expect(closest).toBeLessThan(1.5);
      expect(dist(s.ball.pos, target)).toBeLessThan(5);
    }
  });

  test('a pass does not snap to a teammate unless the pointer is within the assist radius of him or on the line to him', () => {
    const { s, me } = carrier({ x: 30, y: 20 });
    const mate = s.players.find((p) => p.team === 0 && p.role === 'MID')!;
    mate.pos = { x: 40, y: 20 };
    mate.vel = { x: 0, y: 0 };
    mate.stun = 0;
    // Well off to the side (outside the radius, outside the cone): into space.
    const off = { x: 40, y: 20 + assistRadius(10) + 1.5 };
    const r = pointerPass(s, me, off);
    expect(r.receiver).toBe(-1);
    expect(r.target).toEqual(off);
    const near = pointerPass(s, me, { x: 40, y: 20 + assistRadius(10) - 0.3 });
    expect(near.receiver).toBe(mate.i);
    expect(near.target).toEqual(mate.pos);
  });

  test('the assist leads a teammate who is running, so the ball arrives where he will be', () => {
    const { s, me } = carrier({ x: 20, y: 20 });
    const mate = s.players.find((p) => p.team === 0 && p.role === 'MID')!;
    mate.pos = { x: 30, y: 14 };
    mate.vel = { x: 6, y: 0 };
    mate.stun = 0;
    const r = pointerPass(s, me, { x: 30.5, y: 14.5 });
    expect(r.receiver).toBe(mate.i);
    expect(r.target.x).toBeGreaterThan(mate.pos.x + 2);
    // Aim the pointer well ahead of him instead and the ball goes exactly there, a through ball into
    // his path: he is its receiver, so he runs on to it rather than leaving it for whoever is nearest.
    const ahead = { x: 41, y: 14 };
    const through = pointerPass(s, me, ahead);
    expect(through.receiver).toBe(mate.i);
    expect(through.target).toEqual(ahead);
    // Off his line (more than 2 m plus a quarter of the way ahead), it is a ball into space for nobody.
    const wide = { x: 41, y: 21 };
    expect(pointerPass(s, me, wide).receiver).toBe(-1);
  });

  test('a runner collects a ball played into space ahead of him', () => {
    const { s, me } = carrier({ x: 20, y: 20 });
    const mate = s.players.find((p) => p.team === 0 && p.role === 'MID')!;
    mate.pos = { x: 25.5, y: 14 };
    mate.vel = { x: 6, y: 0 };
    mate.stun = 0;
    const spot = { x: 42, y: 14 };
    step(s, { cursor: spot, pass: true });
    me.stun = 100000;
    // He keeps running his line at 6 m/s (placed by hand, so the CPU's own ideas don't matter).
    let got = -1;
    for (let t = 0; t < 240 && got < 0; t++) {
      mate.vel = { x: 6, y: 0 };
      step(s);
      // He runs his line at 6 m/s and drifts toward the ball a little, as a runner would.
      mate.pos = { x: 25.5 + (6 * (t + 1)) / 60, y: mate.pos.y + Math.max(-0.05, Math.min(0.05, s.ball.pos.y - mate.pos.y)) };
      mate.vel = { x: 6, y: 0 };
      if (s.ball.owner >= 0) got = s.ball.owner;
    }
    expect(got).toBe(mate.i);
  });

  test('a ball into a runner\'s path is timed for him and he takes it in stride', () => {
    // Before: the click left him off the pass (no receiver), so he stopped and came back for it,
    // or, picked, stopped on its line to wait: collected at 1-4 m/s.
    for (const ahead of [6, 8, 10]) {
      const { s, me } = carrier({ x: 10, y: 34 });
      const mate = s.players.find((p) => p.team === 0 && p.role === 'MID')!;
      for (const p of s.players) if (p !== me && p !== mate) p.pos = { x: 95 + (p.i % 5), y: 60 + (p.i % 3) };
      mate.pos = { x: 16, y: 34 };
      mate.vel = { x: 6, y: 0 };
      mate.facing = { x: 1, y: 0 };
      mate.stun = 0;
      step(s, { cursor: { x: 16 + ahead, y: 34 }, aim: { x: 16 + ahead, y: 34 }, pass: true, moved: true });
      expect(s.ball.receiver).toBe(mate.i);
      let speed = -1;
      for (let t = 0; t < 300 && speed < 0; t++) {
        step(s, { cursor: { ...me.pos } });
        if (s.ball.owner === mate.i) speed = len(mate.vel);
      }
      expect(speed).toBeGreaterThan(4);
    }
  });

  test('keys: Space passes to the teammate you are heading toward, to feet', () => {
    const { s, me } = carrier({ x: 20, y: 20 });
    const mate = s.players.find((p) => p.team === 0 && p.role === 'MID')!;
    mate.pos = { x: 34, y: 20 };
    mate.vel = { x: 0, y: 0 };
    step(s, { dir: { x: 1, y: 0 }, pass: true });
    expect(s.ball.receiver).toBe(mate.i);
    expect(me.i).toBe(s.ball.lastTouch);
  });
});

describe('lofted ball', () => {
  function loftFrom(hold: number, target: Vec, at: Vec = { x: 20, y: 20 }) {
    const { s, me } = carrier(at);
    const plan = loftPlan(s.ball.pos, target, hold);
    step(s, { cursor: target, loft: hold });
    me.stun = 100000;
    expect(s.ball.vz).toBeGreaterThan(0);
    let peak = 0;
    let touchdown: Vec | null = null;
    let air = false;
    for (let t = 0; t < 300 && !touchdown; t++) {
      step(s);
      peak = Math.max(peak, s.ball.z);
      if (s.ball.z > 0) air = true;
      else if (air) touchdown = { ...s.ball.pos };
    }
    return { plan, peak, touchdown: touchdown! };
  }

  test('lands near the pointer, at any hold, when the pointer is in range', () => {
    for (const hold of [0, 0.3, 0.7, 1]) {
      const target = { x: 20 + Math.min(10, loftRange(hold) - 1), y: 26 };
      const r = loftFrom(hold, target);
      expect(r.touchdown).not.toBeNull();
      expect(dist(r.touchdown, target)).toBeLessThan(2.2);
      expect(dist(r.plan.landing, target)).toBeLessThan(1e-6);
    }
    // A long one needs the long hold.
    const far = { x: 20 + 30, y: 20 };
    expect(dist(loftFrom(1, far).touchdown, far)).toBeLessThan(2.5);
  });

  test('a longer hold peaks higher for the same target, and flies for longer', () => {
    const target = { x: 30, y: 20 };
    const peaks = [0, 0.25, 0.5, 0.75, 1].map((h) => loftFrom(h, target).peak);
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeGreaterThan(peaks[i - 1] + 0.2);
    const flights = [0, 1].map((h) => loftPlan({ x: 20, y: 20 }, target, h).flight);
    expect(flights[1]).toBeGreaterThan(flights[0]);
    // Measured peak matches the plan's.
    const r = loftFrom(0.6, target);
    expect(r.peak).toBeGreaterThan(r.plan.peak - 0.4);
    expect(r.peak).toBeLessThan(r.plan.peak + 0.2);
  });

  test('a short hold cannot reach a far pointer: it lands at the end of its range, the same way', () => {
    const target = { x: 60, y: 20 };
    const r = loftFrom(0, target);
    expect(dist(r.plan.landing, { x: 20.99 + loftRange(0), y: 20 })).toBeLessThan(1e-6);
    expect(dist(r.touchdown, r.plan.landing)).toBeLessThan(2.2);
    expect(loftRange(1)).toBeGreaterThan(loftRange(0) + 20);
  });

  test('it clears defenders: nobody takes it above head height, and the pass counts as no shot', () => {
    const { s, me } = carrier({ x: 20, y: 20 });
    const opp = s.players.find((p) => p.team === 1 && p.role === 'MID')!;
    opp.stun = 0;
    opp.pos = { x: 26, y: 20 };
    step(s, { cursor: { x: 36, y: 20 }, loft: 0.8 });
    me.stun = 100000;
    for (let t = 0; t < 14; t++) {
      opp.pos = { x: 26, y: 20 };
      step(s);
      expect(s.ball.owner).not.toBe(opp.i);
    }
    expect(s.stats[0].shots).toBe(0);
  });

  test('keys: hold C sends it as far as the hold allows the way you are heading', () => {
    const { s, me } = carrier({ x: 20, y: 20 });
    step(s, { dir: { x: 1, y: 0 }, loft: 1 });
    me.stun = 100000;
    expect(s.ball.vz).toBeGreaterThan(3);
    expect(s.ball.vel.x).toBeGreaterThan(8);
    expect(Math.abs(s.ball.vel.y)).toBeLessThan(2);
  });
});

describe('right click shoots toward the pointer', () => {
  test('the shot leaves along the line to the pointer, harder with more power', () => {
    const run = (power: number, target: Vec) => {
      const { s, me } = carrier({ x: 40, y: 20 });
      const from = { ...s.ball.pos };
      step(s, { cursor: target, shoot: power });
      me.stun = 100000;
      expect(s.ball.owner).toBe(-1);
      return { dir: norm(s.ball.vel), speed: len(s.ball.vel), want: norm(sub(target, from)) };
    };
    for (const target of [{ x: 64, y: 17.5 }, { x: 64, y: 22.5 }, { x: 55, y: 5 }, { x: 30, y: 35 }]) {
      const r = run(0.55, target);
      const dot = r.dir.x * r.want.x + r.dir.y * r.want.y;
      expect(dot).toBeGreaterThan(0.97); // within about 14 degrees
    }
    const soft = run(0.55, { x: 64, y: 20 });
    const hard = run(1, { x: 64, y: 20 });
    expect(hard.speed).toBeGreaterThan(soft.speed + 3);
    expect(soft.speed).toBeGreaterThan(15); // a medium shot is a real shot
  });

  test('a shot at the goal counts as a shot, and a miss of the frame does not count on target', () => {
    // 14 m out from the right-hand goal (x = PITCH_W, centred on y = PITCH_H / 2).
    const { s } = carrier({ x: PITCH_W - 14, y: PITCH_H / 2 });
    step(s, { cursor: { x: PITCH_W, y: PITCH_H / 2 }, shoot: 0.55 });
    expect(s.stats[0].shots).toBe(1);
    expect(s.stats[0].onTarget).toBe(1);
    const w = carrier({ x: PITCH_W - 14, y: PITCH_H / 2 });
    step(w.s, { cursor: { x: PITCH_W, y: PITCH_H / 2 - 17 }, shoot: 0.55 });
    expect(w.s.stats[0].shots).toBe(1);
    expect(w.s.stats[0].onTarget).toBe(0);
  });

  test('without the ball a shot input does nothing', () => {
    const s = livePlay();
    const me = s.players[s.controlled[0]];
    oppHasBall(s);
    const before = { ...s.ball.pos };
    step(s, { cursor: me.pos, shoot: 1, loft: 1, pass: true });
    expect(len(sub(s.ball.pos, before))).toBeLessThan(1);
    expect(s.stats[0].shots).toBe(0);
  });
});


describe('left click without the ball picks a player', () => {
  /** Four of ours on known spots around the current player, an opponent holding the ball far away. */
  function setup() {
    const s = livePlay();
    const opp = oppHasBall(s);
    opp.pos = { x: 60, y: 38 };
    s.ball.pos = { ...opp.pos };
    const mates = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
    const [cur, east, northeast, west, south] = mates;
    cur.pos = { x: 30, y: 20 };
    east.pos = { x: 45, y: 20 }; // 15 m due east
    northeast.pos = { x: 38, y: 14 }; // 10 m away, 37 degrees off east
    west.pos = { x: 20, y: 21 }; // 10 m west
    south.pos = { x: 31, y: 35 }; // 15 m south
    // Eleven-a-side: the rest of our outfielders stand well away, behind the keeper's line of sight.
    mates.slice(5).forEach((p, k) => (p.pos = { x: 95 + k * 2, y: 66 }));
    for (const p of s.players) {
      p.vel = { x: 0, y: 0 };
      if (p.team === 0 && p.role === 'GK') p.pos = { x: 2, y: 20 };
    }
    s.controlled[0] = cur.i;
    return { s, cur, east, northeast, west, south };
  }

  test('clicking on or near a teammate (within 4 m of the pointer) switches control to him', () => {
    const { s, cur, east, south } = setup();
    expect(pickTeammate(s, 0, { x: east.pos.x + 1, y: east.pos.y - 0.8 })).toBe(east.i);
    step(s, { cursor: { x: south.pos.x - 0.6, y: south.pos.y + 0.7 }, select: true });
    expect(s.controlled[0]).toBe(south.i);
    expect(s.controlled[0]).not.toBe(cur.i);
    // A couple of metres off him is still him; past PICK_R, with nobody that way, you stay as you are.
    expect(pickTeammate(s, 0, { x: south.pos.x, y: south.pos.y + SELECT_R + 0.3 })).toBe(south.i);
    expect(pickTeammate(s, 0, { x: south.pos.x, y: south.pos.y + PICK_R + 0.3 })).toBe(-1);
  });

  test('the player under the pointer beats one in the cone', () => {
    const { s, east, northeast } = setup();
    expect(pickTeammate(s, 0, { x: east.pos.x, y: east.pos.y })).toBe(east.i);
    // Not on anybody, out east: both are in the cone, the nearer wins.
    expect(pickTeammate(s, 0, { x: 55, y: 20 })).toBe(northeast.i);
  });

  test('clicking elsewhere picks the nearest teammate in that direction from the current player', () => {
    const { s, cur, east, west, south } = setup();
    expect(pickTeammate(s, 0, { x: 55, y: 28 })).toBe(east.i); // east-south-east: only east is inside the cone
    expect(pickTeammate(s, 0, { x: 5, y: 20 })).toBe(west.i);
    expect(pickTeammate(s, 0, { x: 30, y: 38 })).toBe(south.i);
    // Nobody that way (north): stay. Clicking on the current player himself keeps him.
    expect(pickTeammate(s, 0, { x: 30, y: 2 })).toBe(-1);
    expect(pickTeammate(s, 0, { x: 30.2, y: 20.1 })).toBe(cur.i);
    // Through the sim: the cone click moves control, the empty one leaves it.
    step(s, { cursor: { x: 5, y: 20 }, select: true });
    expect(s.controlled[0]).toBe(west.i);
    const t = setup();
    step(t.s, { cursor: { x: 30, y: 2 }, select: true });
    expect(t.s.controlled[0]).toBe(t.cur.i);
  });

  test('goalkeepers are never picked', () => {
    const { s } = setup();
    const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
    expect(pickTeammate(s, 0, gk.pos)).not.toBe(gk.i);
  });

  test('a hand-picked player is kept for a while: the auto-switch does not snatch him back', () => {
    const { s, cur, south } = setup();
    isolate(s, south); // nobody else runs onto the loose ball
    // Loose ball next to the current player, so auto-switch would love to keep him.
    s.ball.owner = -1;
    s.ball.pos = { x: 28, y: 20 };
    s.ball.vel = { x: 0, y: 0 };
    step(s, { cursor: south.pos, select: true });
    expect(s.controlled[0]).toBe(south.i);
    for (let t = 0; t < 120; t++) {
      s.ball.pos = { x: 28, y: 20 };
      s.ball.vel = { x: 0, y: 0 };
      cur.pos = { x: 28, y: 20.5 };
      cur.stun = 100000; // keeps him from simply collecting the ball
      step(s, { cursor: south.pos });
      expect(s.controlled[0]).toBe(south.i);
    }
  });

  test('clicking does nothing while your team has the ball: you steer the carrier', () => {
    const { s, cur, east } = setup();
    s.ball.owner = cur.i;
    s.ball.pos = { x: 31, y: 20 };
    step(s, { cursor: east.pos, select: true });
    expect(s.controlled[0]).toBe(cur.i);
  });

  test('a click a couple of metres off a man picks him, not someone nearer you in that direction', () => {
    // Before: past 1.5 m the click fell to the cone search, which took whoever in that direction
    // lay nearest the current player: northeast (10 m from cur) for a click 2.5 m off east.
    const { s, east, northeast } = setup();
    northeast.pos = { x: 37, y: 18 }; // nearer cur, and inside the cone toward east
    for (const [dx, dy] of [[-2.5, 0], [0, 2.5], [1.8, -1.8], [0, -3]]) {
      expect(pickTeammate(s, 0, { x: east.pos.x + dx, y: east.pos.y + dy })).toBe(east.i);
    }
  });
});

describe('the automatic switch does not surprise', () => {
  /** A loose ball rolling along y = 30; our men placed by the caller; the opponent far away. */
  function loose(ballAt: Vec, vel: Vec) {
    const s = livePlay();
    for (const p of s.players) {
      p.pos = { x: 95 + (p.i % 5), y: 60 + (p.i % 3) };
      p.vel = { x: 0, y: 0 };
      p.stun = 100000;
    }
    Object.assign(s.ball, { owner: -1, receiver: -1, lastTouch: -1, kickedBy: -1, pos: { ...ballAt }, vel: { ...vel }, z: 0, vz: 0 });
    s.ball.noPickup.fill(0);
    const ours = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
    return { s, a: ours[0], b: ours[1] };
  }

  test('once it has switched, it keeps the new man a moment instead of flicking back', () => {
    const { s, a, b } = loose({ x: 40, y: 30 }, { x: 0, y: 0 });
    a.pos = { x: 52, y: 30 };
    b.pos = { x: 41, y: 30 };
    s.controlled[0] = a.i;
    s.switchTimer[0] = 0;
    step(s, { cursor: s.ball.pos });
    expect(s.controlled[0]).toBe(b.i);
    // Now a is the nearer one by far: still b for AUTO_KEEP ticks.
    a.pos = { x: 41, y: 30 };
    b.pos = { x: 52, y: 30 };
    for (let t = 0; t < 40; t++) {
      step(s, { cursor: s.ball.pos });
      expect(s.controlled[0]).toBe(b.i);
    }
  });

  test('never off a man the ball is coming to and nearly at', () => {
    // The ball, fast, is 2 m from a and running at him; b is nearer where it will be in 0.3 s.
    const { s, a, b } = loose({ x: 40, y: 30 }, { x: 25, y: 0 });
    a.pos = { x: 42, y: 30.5 };
    b.pos = { x: 47.5, y: 30 };
    s.controlled[0] = a.i;
    s.switchTimer[0] = 0;
    step(s, { cursor: a.pos });
    expect(s.controlled[0]).toBe(a.i);
  });
});

describe('right click without the ball tackles', () => {
  /** Our player on the spot, an opponent with the ball `gap` metres east of him. */
  function duel(seed: number, gap: number) {
    const s = createMatch({ seed, ...teams(7), halfSeconds: 60 });
    kickOff(s);
    const me = s.players[s.controlled[0]];
    const opp = oppHasBall(s);
    isolate(s, me, opp);
    me.stun = 0;
    me.tackleCd = 0;
    me.pos = { x: 30, y: 20 };
    me.vel = { x: 0, y: 0 };
    me.attrs.defending = 1;
    opp.attrs.dribbling = 0;
    opp.stun = 0;
    opp.pos = { x: 30 + gap, y: 20 };
    opp.vel = { x: 0, y: 0 };
    opp.facing = { x: -1, y: 0 };
    s.ball.owner = opp.i;
    s.ball.pos = { x: 30 + gap - 0.9, y: 20 };
    s.controlled[0] = me.i;
    return { s, me, opp };
  }
  const winsOver = (gap: number, cursorDx: number, n = 24) => {
    let wins = 0;
    let cd = 0;
    for (let seed = 1; seed <= n; seed++) {
      const { s, me } = duel(seed, gap);
      const tk = s.stats[0].tackles;
      const cursor = { x: me.pos.x + cursorDx, y: me.pos.y };
      step(s, { cursor, tackle: true });
      cd = me.tackleCd;
      // A slide is judged as it travels (match.ts slideTackles), so watch it play out.
      for (let t = 0; t < 30 && s.phase === 'play'; t++) step(s, { cursor });
      if (s.stats[0].tackles > tk) wins++;
    }
    return { wins, cd };
  };

  test('close to the pointer it is a standing tackle: a lunge that wins the ball from a carrier in reach', () => {
    const r = winsOver(1.3, 1.5);
    expect(r.wins).toBeGreaterThan(14);
    expect(r.cd).toBe(36);
  });

  test('a far pointer slides: it reaches a carrier a standing tackle cannot, and costs a longer recovery', () => {
    // 2.6 m is out of a standing tackle's 2 m reach, so a click on him (or the ball) there slides too.
    const onHim = winsOver(2.6, 2);
    expect(onHim.cd).toBe(70);
    expect(onHim.wins).toBeGreaterThan(8);
    const slide = winsOver(2.6, 5);
    expect(slide.wins).toBeGreaterThan(8);
    expect(slide.cd).toBe(70);
    const { s, me } = duel(3, 2.6);
    step(s, { cursor: { x: me.pos.x + 5, y: me.pos.y }, tackle: true });
    expect(me.vel.x).toBeGreaterThan(8); // really goes in
    expect(me.stun).toBeGreaterThan(5); // and is on the floor a moment
  });

  test('a slide only counts toward where the pointer is: sliding the wrong way misses', () => {
    let wins = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const { s, me, opp } = duel(seed, 2.6);
      step(s, { cursor: { x: me.pos.x - 5, y: me.pos.y }, tackle: true });
      if (s.ball.owner !== opp.i) wins++;
    }
    expect(wins).toBe(0);
  });

  test('humanIntent: standing inside the radius, a slide beyond it capped at SLIDE_MAX, nothing with the ball', () => {
    const { s, me } = duel(1, 6);
    const near = humanIntent(s, me, { cursor: { x: me.pos.x + STAND_TACKLE_R - 0.2, y: me.pos.y }, tackle: true }).action;
    expect(near).toMatchObject({ kind: 'tackle' });
    expect((near as { slide?: boolean }).slide).toBeUndefined();
    const far = humanIntent(s, me, { cursor: { x: me.pos.x + 30, y: me.pos.y }, tackle: true }).action as { kind: 'tackle'; target: Vec; slide?: boolean };
    expect(far.slide).toBe(true);
    expect(dist(far.target, me.pos)).toBeCloseTo(SLIDE_MAX, 6);
    const mid = humanIntent(s, me, { cursor: { x: me.pos.x + 4, y: me.pos.y }, tackle: true }).action as { target: Vec; slide?: boolean };
    expect(mid.slide).toBe(true);
    expect(dist(mid.target, me.pos)).toBeCloseTo(4, 6);
    // With the ball, a tackle input is ignored.
    const c = carrier();
    expect(humanIntent(c.s, c.me, { cursor: { x: 30, y: 20 }, tackle: true }).action).toBeUndefined();
  });

  test('keys: Space without the ball goes for the ball', () => {
    const { s, me } = duel(4, 1.3);
    step(s, { dir: { x: 0, y: 0 }, tackle: true });
    expect(me.tackleCd).toBeGreaterThan(30);
  });
});

describe('determinism and replay with the new inputs', () => {
  /** A scripted pointer player who uses every input. */
  function script(t: number): HumanInput {
    const i: HumanInput = { cursor: { x: 32 + 24 * Math.sin(t / 61), y: 20 + 14 * Math.cos(t / 47) } };
    if (t % 77 === 0) i.pass = true;
    if (t % 131 === 5) i.loft = ((t / 131) % 5) / 4;
    if (t % 173 === 9) i.shoot = 0.55 + ((t / 173) % 4) / 9;
    if (t % 53 === 20) i.tackle = true;
    if (t % 97 === 30) i.select = true;
    return i;
  }

  test('two runs of the same scripted pointer player are the same match', () => {
    const run = () => {
      const s = createMatch({ seed: 21, ...teams(3), halfSeconds: 30 });
      for (let t = 0; s.phase !== 'fulltime'; t++) step(s, script(t));
      return `${fingerprint(s)}#${s.rng.s}#${s.stats[0].passes}:${s.stats[0].shots}:${s.stats[0].tackles}`;
    };
    expect(run()).toBe(run());
  });

  test('the script really passes, lofts, shoots, tackles and switches', () => {
    const s = createMatch({ seed: 21, ...teams(3), halfSeconds: 90 });
    const seen = { loft: 0, tackle: 0, select: 0, shot: 0, pass: 0 };
    const spy = (i: HumanInput) => {
      const me = s.players[s.controlled[0]];
      const had = s.ball.owner === me.i;
      const before = s.controlled[0];
      const cd = me.tackleCd;
      step(s, i);
      if (had && i.loft !== undefined && s.ball.vz > 0) seen.loft++;
      if (had && i.shoot !== undefined && s.ball.owner === -1) seen.shot++;
      if (had && i.pass && s.ball.owner === -1) seen.pass++;
      if (!had && i.tackle && me.tackleCd > cd) seen.tackle++;
      if (!had && i.select && s.controlled[0] !== before) seen.select++;
    };
    for (let t = 0; s.phase !== 'fulltime'; t++) spy(script(t));
    expect(seen.pass).toBeGreaterThan(0);
    expect(seen.loft).toBeGreaterThan(0);
    expect(seen.shot).toBeGreaterThan(0);
    expect(seen.tackle).toBeGreaterThan(0);
    expect(seen.select).toBeGreaterThan(0);
  });

  test('a recorded match with the new inputs survives a replay code and re-simulates to the same final state', () => {
    const t = teams(3);
    const opts = { seed: 21, ...t, halfSeconds: 20, humanTeam: 0 as const };
    const s = createMatch(opts);
    const rec = new ReplayRecorder(opts, 'Controls');
    for (let n = 0; s.phase !== 'fulltime'; n++) step(s, rec.push(script(n)));
    const replay = rec.finish(s, 1_700_000_000);
    const back = decodeReplay(encodeReplay(replay));
    expect(back).toEqual(replay);
    expect(finalHash(replayTo(back, back.ticks))).toBe(replay.fp);
    expect(fingerprint(replayTo(back, back.ticks))).toBe(fingerprint(s));
    expect(back.runs.some((r) => r.input.loft !== undefined)).toBe(true);
    expect(back.runs.some((r) => r.input.tackle)).toBe(true);
    expect(back.runs.some((r) => r.input.select)).toBe(true);
  });

  test('two humans on the pointer scheme in one match stay deterministic', () => {
    const run = () => {
      const s = createMatch({ seed: 8, ...teams(5), halfSeconds: 15, humans: [true, true] });
      for (let t = 0; s.phase !== 'fulltime'; t++) {
        const b = script(t + 40);
        if (b.cursor) b.cursor = { x: 64 - b.cursor.x, y: 40 - b.cursor.y };
        step(s, [script(t), b]);
      }
      return `${fingerprint(s)}#${s.rng.s}`;
    };
    expect(run()).toBe(run());
  });
});
