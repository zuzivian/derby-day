// Corners the human can play: a cross lands where the left button went down, driven or floated by the hold and
// swung by a sideways drag; a man comes short; the attackers wait a few metres out and attack their zones as it is
// struck; markers challenge for the ball; and the keeper comes for a floated ball into his six-yard box.

import { describe, expect, test } from 'bun:test';
import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { GOAL_W, PITCH_H, PITCH_W } from '../src/sim/constants.ts';
import { goalkeeper, oppGoal } from '../src/sim/field.ts';
import { createMatch, step } from '../src/sim/match.ts';
import { awardRestart } from '../src/sim/rules.ts';
import type { HumanInput, MatchState } from '../src/sim/types.ts';
import { dist, type Vec } from '../src/sim/vec.ts';
import { kickOff } from './helpers.ts';

const MID = PITCH_H / 2;

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  return { home: { ...cpuTeam(a, ladderSquad(a)), formation: '4-4-2' as const }, away: { ...cpuTeam(b, ladderSquad(b)), formation: '4-4-2' as const } };
}

const still = (s: MatchState): HumanInput => ({ cursor: { ...s.players[s.controlled[0]].pos } });

/**
 * A corner to the human side (attacking x = 105 in the first half) from the top (y = 0) or bottom flag, after both
 * sides have gathered at that end as they would after an attack. Returns at the first tick it can be taken.
 */
function corner(seed: number, bottom = false): MatchState {
  const s = createMatch({ seed, ...teams(7 + (seed % 3) * 2), halfSeconds: 900, humanTeam: 0 });
  kickOff(s);
  const g = oppGoal(s, 0);
  const near = bottom ? 1 : -1;
  const ball = { x: g.x - 9, y: MID + near * 7 };
  const dx = 0.85 * (ball.x - PITCH_W / 2);
  for (const p of s.players) {
    if (p.role === 'GK') continue;
    p.pos = { x: Math.min(103, Math.max(2, PITCH_W / 2 + (p.pos.x - PITCH_W / 2) * 0.5 + dx)), y: p.pos.y };
    p.vel = { x: 0, y: 0 };
  }
  Object.assign(s.ball, { owner: -1, receiver: -1, inHands: false, pos: { ...ball }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  s.ball.noPickup.fill(130);
  for (let t = 0; t < 120; t++) step(s, still(s));
  awardRestart(s, 'corner', 0, { x: g.x + 0.5, y: bottom ? PITCH_H : 0 }, 'out');
  for (let n = 0; n < 900 && s.restart && s.restart.stage !== 'ready'; n++) step(s, still(s));
  return s;
}

const near = (s: MatchState): number => (s.restart!.spot.y < MID ? -1 : 1);
const zones = (s: MatchState): Record<string, Vec> => {
  const gx = oppGoal(s, 0).x;
  const n = near(s);
  return { near: { x: gx - 5, y: MID + n * (GOAL_W / 2 - 0.5) }, pen: { x: gx - 11, y: MID }, far: { x: gx - 6, y: MID - n * (GOAL_W / 2 + 0.5) } };
};

/** Cross it (left held `hold`, pressed at `at`, dragged to `curl`), everyone else out of the way: where does it land, how high, how long? */
function flight(s: MatchState, at: Vec, hold: number, curl = 0) {
  for (const p of s.players)
    if (p.i !== s.restart!.taker) {
      p.pos = { x: 20 + p.i, y: 60 };
      p.stun = 1e7;
    }
  const from = { ...s.restart!.spot };
  step(s, { cursor: at, aim: at, loft: hold, ...(curl ? { curl } : {}) });
  let peak = 0;
  let t = 0;
  const path: Vec[] = [];
  for (; t < 400 && !(s.ball.z === 0 && t > 5); t++) {
    path.push({ ...s.ball.pos });
    step(s, still(s));
    peak = Math.max(peak, s.ball.z);
  }
  return { land: { ...s.ball.pos }, peak, secs: t / 60, path, from };
}

describe('the human crosses a corner', () => {
  test('it comes down where the button went down, near post, penalty spot or far post, whatever the hold', () => {
    let worst = 0;
    for (const seed of [1, 2, 3]) {
      for (const bottom of [false, true]) {
        for (const z of ['near', 'pen', 'far']) {
          for (const hold of [0.1, 0.5, 0.95]) {
            const s = corner(seed, bottom);
            const at = zones(s)[z];
            worst = Math.max(worst, dist(flight(s, at, hold).land, at));
          }
        }
      }
    }
    // On main the loft's range was capped at 12 + 28 x hold: a short hold to the near post came down 8.7 m short of it.
    expect(worst).toBeLessThan(1.5);
  });

  test('a short hold drives it, a long one floats it', () => {
    const s1 = corner(4);
    const s2 = structuredClone(s1);
    const at = zones(s1).pen;
    const driven = flight(s1, at, 0.05);
    const floated = flight(s2, at, 1);
    expect(driven.peak).toBeLessThan(5);
    expect(floated.peak).toBeGreaterThan(driven.peak + 2.5);
    expect(floated.secs).toBeGreaterThan(driven.secs + 0.5);
  });

  test('a sideways drag swings it in or out, and it still lands on the spot', () => {
    for (const curl of [1, -1]) {
      const s = corner(5);
      const at = zones(s).far;
      const f = flight(s, at, 0.5, curl);
      expect(dist(f.land, at)).toBeLessThan(1.5);
      const ux = (at.x - f.from.x) / dist(at, f.from);
      const uy = (at.y - f.from.y) / dist(at, f.from);
      const bow = Math.max(...f.path.map((p) => Math.abs((p.x - f.from.x) * -uy + (p.y - f.from.y) * ux)));
      expect(bow).toBeGreaterThan(1);
    }
  });
});

describe('the attacking side at a corner', () => {
  test('a man comes short for the human, and a click to him keeps it', () => {
    let kept = 0;
    let n = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const bottom of [false, true]) {
        const s = corner(seed, bottom);
        const r = s.restart!;
        const mate = s.players.filter((p) => p.team === 0 && p.i !== r.taker && p.role !== 'GK').sort((a, b) => dist(a.pos, r.spot) - dist(b.pos, r.spot))[0];
        // On main the nearest man was 34.8 m away on average, on the edge of the box.
        expect(dist(mate.pos, r.spot)).toBeLessThan(12);
        step(s, { cursor: { ...mate.pos }, aim: { ...mate.pos }, pass: true, moved: true });
        for (let t = 0; t < 120 && !(s.ball.owner >= 0 && s.ball.owner !== r.taker); t++) step(s, still(s));
        n++;
        if (s.ball.owner >= 0 && s.players[s.ball.owner].team === 0) kept++;
      }
    }
    expect(kept / n).toBeGreaterThan(0.55);
  });

  test('the men in the box wait a few metres out and attack their zones as it is struck', () => {
    let closed = 0;
    let n = 0;
    for (const seed of [1, 2, 3, 4]) {
      const s = corner(seed);
      const runs = s.runs!;
      const men = s.players.filter((p) => p.team === 0 && runs[p.i]);
      expect(men.length).toBeGreaterThanOrEqual(4);
      const before = men.map((p) => dist(p.pos, runs[p.i]!));
      const at = zones(s).pen;
      step(s, { cursor: at, aim: at, loft: 0.6 });
      for (let t = 0; t < 60; t++) step(s, still(s));
      men.forEach((p, k) => {
        n++;
        if (p.i === s.controlled[0]) return;
        if (dist(p.pos, runs[p.i]!) < before[k] - 1.5) closed++;
      });
    }
    // On main nobody waited out of his zone, and once the ball was struck they all drifted back into support positions.
    expect(closed / n).toBeGreaterThan(0.5);
  });
});

describe('the defence at a corner', () => {
  test('markers challenge: a cross to a marked man is often won by the defender', () => {
    let ours = 0;
    let theirs = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      for (const bottom of [false, true]) {
        const s = corner(seed, bottom);
        const at = zones(s).pen;
        const taker = s.restart!.taker;
        step(s, { cursor: at, aim: at, loft: 0.3 });
        for (let t = 0; t < 240; t++) {
          const lt = s.ball.lastTouch;
          if (lt >= 0 && lt !== taker) {
            if (s.players[lt].team === 0) ours++;
            else if (s.players[lt].role !== 'GK') theirs++;
            break;
          }
          step(s, still(s));
        }
      }
    }
    // On main the defenders won 0% of driven crosses to the penalty spot once our men got there first.
    expect(theirs).toBeGreaterThan(4);
    expect(ours).toBeGreaterThan(4);
  });

  test('the keeper comes for a floated ball into his six-yard box, not a driven one', () => {
    let floatedClaims = 0;
    let drivenClaims = 0;
    // 24 seeds, not 8: about one floated ball in three is claimed, and 8 seeds moved between 1 and 3
    // claims whenever anything in the sim changed (40 seeds: 12 here, 14 on main; driven 0 on both).
    for (const seed of Array.from({ length: 24 }, (_, i) => i + 1)) {
      for (const [hold, count] of [
        [1, (n: number) => (floatedClaims += n)],
        [0.05, (n: number) => (drivenClaims += n)],
      ] as const) {
        const s = corner(seed);
        const gk = goalkeeper(s, 1);
        const at = { x: oppGoal(s, 0).x - 4.5, y: MID };
        step(s, { cursor: at, aim: at, loft: hold });
        let claim = 0;
        for (let t = 0; t < 240 && s.phase === 'play'; t++) {
          if (s.ball.owner === gk.i) {
            claim = 1;
            break;
          }
          if (s.ball.lastTouch !== s.ball.restartBy && s.ball.lastTouch >= 0 && s.players[s.ball.lastTouch].team === 0) break;
          step(s, still(s));
        }
        count(claim);
      }
    }
    expect(floatedClaims).toBeGreaterThan(drivenClaims);
    expect(floatedClaims).toBeGreaterThanOrEqual(4);
  });
});
