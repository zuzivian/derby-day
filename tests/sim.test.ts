import { describe, expect, test } from 'bun:test';
import { generateLadder, generateSquad, autoLineup, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { PITCH_H, PITCH_W } from '../src/sim/constants.ts';
import { chipPlan, loftPlan } from '../src/sim/kicks.ts';
import { createMatch, fingerprint, simulate, step } from '../src/sim/match.ts';
import { makeRng } from '../src/sim/rng.ts';
import type { HumanInput, MatchState } from '../src/sim/types.ts';
import { dot, len, norm, sub } from '../src/sim/vec.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

describe('match sim', () => {
  test('same seed and inputs give the same match', () => {
    const run = () => {
      const s = createMatch({ seed: 42, ...teams(7), halfSeconds: 20 });
      const inputs: HumanInput[] = [];
      for (let t = 0; t < 3000; t++) inputs.push(t % 90 === 0 ? { cursor: { x: 50, y: 10 + (t % 20) }, pass: true } : { cursor: { x: 40, y: 20 } });
      for (const i of inputs) step(s, i);
      return fingerprint(s);
    };
    expect(run()).toBe(run());
  });

  test('different seeds diverge', () => {
    const a = simulate({ seed: 1, ...teams(7), halfSeconds: 30 });
    const b = simulate({ seed: 2, ...teams(7), halfSeconds: 30 });
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  test('a CPU match finishes with a plausible scoreline and real play', () => {
    const s = simulate({ seed: 99, ...teams(3), halfSeconds: 120 });
    expect(s.phase).toBe('fulltime');
    const total = s.score[0] + s.score[1];
    expect(total).toBeLessThan(25);
    expect(s.stats[0].passes + s.stats[1].passes).toBeGreaterThan(20);
    expect(s.stats[0].shots + s.stats[1].shots).toBeGreaterThan(2);
    for (const p of s.players) {
      expect(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)).toBe(true);
    }
  });

  test('stronger squads win more often', () => {
    let strongWins = 0;
    let weakWins = 0;
    for (let i = 0; i < 12; i++) {
      const r = makeRng(1000 + i);
      const strong = generateSquad(r, 78);
      const weak = generateSquad(r, 46);
      const id = { id: 'x', name: 'S', short: 'S', primary: '#000', secondary: '#fff', crest: 'plain' as const };
      const s = simulate({ seed: i, home: toTeamSetup(id, strong, autoLineup(strong)), away: toTeamSetup(id, weak, autoLineup(weak)), halfSeconds: 90 });
      if (s.score[0] > s.score[1]) strongWins++;
      if (s.score[1] > s.score[0]) weakWins++;
    }
    expect(strongWins).toBeGreaterThan(weakWins);
  });
});

function livePlay(seed = 5): MatchState {
  const s = createMatch({ seed, ...teams(7), halfSeconds: 60 });
  while (s.phase !== 'play') step(s);
  return s;
}

describe('sprint (key scheme; the pointer sprints by distance, see controls.test.ts)', () => {
  test('sprinting is about 18% faster than running and costs energy', () => {
    const peak = (sprint: boolean) => {
      const s = livePlay();
      const me = s.players[s.controlled[0]];
      let top = 0;
      for (let t = 0; t < 100; t++) {
        step(s, { dir: { x: me.team === 0 ? 1 : -1, y: 0 }, sprint });
        top = Math.max(top, len(s.players[s.controlled[0]].vel));
      }
      return { top, energy: s.players[s.controlled[0]].energy };
    };
    const run = peak(false);
    const sprint = peak(true);
    expect(sprint.top / run.top).toBeGreaterThan(1.12);
    expect(sprint.top / run.top).toBeLessThan(1.22);
    expect(sprint.energy).toBeLessThan(run.energy);
  });

  test('a long sprint runs the legs flat, then locks until recovered', () => {
    const s = livePlay();
    const id = s.controlled[0];
    let sawWinded = false;
    for (let t = 0; t < 60 * 20; t++) {
      const me = s.players[id];
      for (const p of s.players) if (p.i !== id) p.stun = 1000; // keep control on this player
      // Zig-zag across the pitch so the player never stops against a board.
      const dx = Math.floor(t / 90) % 2 === 0 ? 1 : -1;
      step(s, { dir: { x: dx, y: 0 }, sprint: true });
      if (s.players[id].winded) {
        sawWinded = true;
        expect(s.players[id].sprinting).toBe(false);
      }
      expect(me.energy).toBeGreaterThanOrEqual(0.4);
    }
    expect(sawWinded).toBe(true);
  });
});

describe('chip and ball height', () => {
  test('a chip goes up, comes down, bounces with damping and z is never negative', () => {
    const s = livePlay();
    const me = s.players[s.controlled[0]];
    const target = { x: me.pos.x + 12 * (me.team === 0 ? 1 : -1), y: me.pos.y };
    step(s, { cursor: target, loft: 0.7 });
    expect(s.ball.vz).toBeGreaterThan(3);
    let peak = 0;
    let lands = 0;
    let wasAir = false;
    for (let t = 0; t < 400; t++) {
      s.players.forEach((p) => (p.stun = 1000)); // nobody interferes
      step(s);
      expect(s.ball.z).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(s.ball.z)).toBe(true);
      peak = Math.max(peak, s.ball.z);
      if (s.ball.z > 0) wasAir = true;
      else if (wasAir) {
        lands++;
        wasAir = false;
      }
    }
    expect(peak).toBeGreaterThan(1.5);
    expect(lands).toBeGreaterThanOrEqual(2); // the bounce counts
    expect(s.ball.z).toBe(0);
    expect(s.ball.vz).toBe(0);
  });

  test('bounces lose height each time', () => {
    const s = livePlay();
    s.players.forEach((p) => (p.stun = 100000));
    s.ball.owner = -1;
    s.ball.pos = { x: 32, y: 20 };
    s.ball.vel = { x: 0, y: 0 };
    s.ball.z = 4;
    const peaks: number[] = [];
    let prev = s.ball.z;
    let rising = false;
    for (let t = 0; t < 300; t++) {
      step(s);
      expect(s.ball.z).toBeGreaterThanOrEqual(0);
      if (s.ball.z > prev) rising = true;
      else if (rising && s.ball.z < prev) {
        peaks.push(prev);
        rising = false;
      }
      prev = s.ball.z;
    }
    expect(peaks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeLessThan(peaks[i - 1]);
  });

  test('chip lands near the target when it is in range, and short when power is low', () => {
    const from = { x: 20, y: 20 };
    const near = chipPlan(from, { x: 32, y: 20 }, 0.8);
    expect(Math.abs(near.landing.x - 32)).toBeLessThan(0.01);
    const short = chipPlan(from, { x: 60, y: 20 }, 0.1);
    expect(short.landing.x).toBeLessThan(32);
  });

  test('a high ball cannot be taken, a low one can', () => {
    const s = livePlay();
    const opp = s.players.find((p) => p.team === 1 && p.role === 'MID')!;
    s.players.forEach((p) => (p.stun = p === opp ? 0 : 100000));
    const drop = (z: number) => {
      s.ball.owner = -1;
      s.ball.receiver = -1;
      s.ball.noPickup.fill(0);
      s.ball.pos = { ...opp.pos };
      s.ball.vel = { x: 0, y: 0 };
      s.ball.z = z;
      s.ball.vz = 0;
      step(s);
      return s.ball.owner;
    };
    expect(drop(2.0)).toBe(-1);
    expect(drop(0.6)).toBe(opp.i);
  });

  test('first touch settles the ball into the feet instead of snapping', () => {
    const s = livePlay();
    const me = s.players[s.controlled[0]];
    s.players.forEach((p) => {
      if (p !== me) p.stun = 100000;
    });
    s.ball.owner = -1;
    s.ball.noPickup.fill(0);
    s.ball.pos = { x: me.pos.x + 1.0, y: me.pos.y };
    s.ball.vel = { x: -9, y: 0 };
    const jumps: number[] = [];
    let last = { ...s.ball.pos };
    for (let t = 0; t < 14; t++) {
      step(s, { cursor: me.pos });
      jumps.push(len(sub(s.ball.pos, last)));
      last = { ...s.ball.pos };
    }
    expect(s.ball.owner).toBe(me.i);
    expect(Math.max(...jumps)).toBeLessThan(0.45);
  });
});

describe('determinism with the new inputs', () => {
  test('pointer passes, lofts, shots, tackles and selects replay identically', () => {
    const run = () => {
      const s = createMatch({ seed: 11, ...teams(4), halfSeconds: 20 });
      for (let t = 0; t < 3600; t++) {
        const i: HumanInput = { cursor: { x: 30 + 20 * Math.sin(t / 70), y: 20 + 12 * Math.cos(t / 50) } };
        if (t % 80 === 0) i.pass = true;
        if (t % 130 === 0) i.loft = (t % 7) / 7;
        if (t % 170 === 0) i.shoot = 0.55 + (t % 5) / 12;
        if (t % 60 === 7) i.tackle = true;
        if (t % 90 === 11) i.select = true;
        step(s, i);
      }
      return fingerprint(s);
    };
    expect(run()).toBe(run());
  });
});

describe('chip landing and point-blank chips', () => {
  test('the first bounce is where loftPlan said it would be', () => {
    const s = livePlay();
    const me = s.players[s.controlled[0]];
    const target = { x: me.pos.x + 14 * (me.team === 0 ? 1 : -1), y: me.pos.y + 3 };
    const plan = loftPlan(s.ball.pos, target, 1);
    step(s, { cursor: target, loft: 1 });
    let touchdown: { x: number; y: number } | null = null;
    for (let t = 0; t < 200 && !touchdown; t++) {
      s.players.forEach((p) => (p.stun = 1000));
      step(s);
      if (s.ball.z === 0) touchdown = { ...s.ball.pos };
    }
    expect(touchdown).not.toBeNull();
    expect(len(sub(touchdown!, plan.landing))).toBeLessThan(2.5);
  });

  test('a defender touching the ball cannot take a chip', () => {
    const s = livePlay();
    const me = s.players[s.controlled[0]];
    const opp = s.players.find((p) => p.team !== me.team && p.role === 'MID')!;
    s.players.forEach((p) => {
      if (p !== me && p !== opp) p.stun = 100000;
    });
    opp.pos = { x: s.ball.pos.x + 0.9 * (me.team === 0 ? 1 : -1), y: s.ball.pos.y };
    opp.vel = { x: 0, y: 0 };
    step(s, { cursor: { x: opp.pos.x + 10 * (me.team === 0 ? 1 : -1), y: opp.pos.y }, loft: 0.8 });
    for (let t = 0; t < 8; t++) {
      step(s, { cursor: opp.pos });
      expect(s.ball.owner).not.toBe(opp.i);
    }
  });
});

describe('kick-off', () => {
  test('the ball is not frozen: play moves it within two seconds', () => {
    for (const seed of [1, 2, 3]) {
      const s = createMatch({ seed, ...teams(7), humanTeam: -1, halfSeconds: 30 });
      while (s.phase !== 'play') step(s);
      const start = { ...s.ball.pos };
      let moved = 0;
      for (let t = 0; t < 120; t++) {
        step(s);
        moved = Math.max(moved, len(sub(s.ball.pos, start)));
      }
      expect(moved).toBeGreaterThan(3);
    }
  });
});

describe('CPU', () => {
  const id = (name: string) => ({ id: name, name, short: name, primary: '#000', secondary: '#fff', crest: 'plain' as const });

  test('skill matters on its own: identical squads, sharp CPU beats sloppy CPU', () => {
    let sharp = 0;
    let sloppy = 0;
    for (let i = 0; i < 10; i++) {
      const squad = generateSquad(makeRng(700 + i), 62);
      const lineup = autoLineup(squad);
      const a = toTeamSetup(id('A'), squad, lineup, 0.9);
      const b = toTeamSetup(id('B'), squad, lineup, 0.15);
      const home = i % 2 === 0;
      const s = simulate({ seed: 40 + i, home: home ? a : b, away: home ? b : a, halfSeconds: 60 });
      const [ga, gb] = home ? s.score : [s.score[1], s.score[0]];
      if (ga > gb) sharp++;
      if (gb > ga) sloppy++;
    }
    expect(sharp).toBeGreaterThan(sloppy * 2);
    expect(sharp).toBeGreaterThanOrEqual(5);
  });

  test('a cloned mid-match state replays identically (the AI keeps no hidden state)', () => {
    const s = createMatch({ seed: 5, ...teams(9), halfSeconds: 30, humanTeam: -1 });
    for (let t = 0; t < 900; t++) step(s);
    const copy = structuredClone(s) as MatchState;
    for (let t = 0; t < 900; t++) {
      step(s);
      step(copy);
    }
    expect(fingerprint(copy)).toBe(fingerprint(s));
  });

  test('keepers stand between the ball and the middle of their goal', () => {
    const s = createMatch({ seed: 3, ...teams(4), halfSeconds: 30, humanTeam: -1 });
    let checked = 0;
    let onLine = 0;
    for (let t = 0; t < 1800; t++) {
      step(s);
      if (s.phase !== 'play' || s.ball.owner < 0) continue;
      const owner = s.players[s.ball.owner];
      const gk = s.players.find((p) => p.role === 'GK' && p.team !== owner.team)!;
      const goal = { x: gk.team === 0 ? 0 : PITCH_W, y: PITCH_H / 2 };
      if (Math.abs(owner.pos.x - goal.x) > PITCH_W * 0.6) continue;
      checked++;
      const toBall = norm(sub(owner.pos, goal));
      const toGk = sub(gk.pos, goal);
      if (len(toGk) < 0.8 || dot(norm(toGk), toBall) > 0.7) onLine++;
    }
    expect(checked).toBeGreaterThan(50);
    expect(onLine / checked).toBeGreaterThan(0.75);
  });
});

describe('goal line', () => {
  // Regression: a fast ball skipped the end-wall bounce band in one tick and was
  // clamped into the goal mouth, scoring shots that went well wide.
  function shotAtWall(y: number, vx: number, z: number, phase: number, fromX = 50): number {
    const s = livePlay();
    s.players.forEach((p) => (p.stun = 100000));
    s.ball.owner = -1;
    s.ball.receiver = -1;
    s.ball.pos = { x: fromX + phase, y };
    s.ball.vel = { x: vx, y: 0 };
    s.ball.z = z;
    s.ball.vz = 0;
    const before = s.score[0] + s.score[1];
    for (let t = 0; t < 120 && s.phase === 'play'; t++) step(s);
    return s.score[0] + s.score[1] - before;
  }

  test('hard shots that hit the end wall outside the mouth never score', () => {
    let goals = 0;
    for (const y of [3, 8, 12, 14.5, 26, 34])
      for (let i = 0; i < 25; i++) goals += shotAtWall(y, 30, 0, i / 25);
    expect(goals).toBe(0);
  });

  test('a ball over the bar does not score, one under it does', () => {
    let over = 0;
    for (let i = 0; i < 25; i++) over += shotAtWall(PITCH_H / 2, 20, 3.6, i / 25, 61); // crosses the line still ~3.5 m up
    expect(over).toBe(0);
    expect(shotAtWall(PITCH_H / 2, 20, 0, 0)).toBe(1);
  });
});
