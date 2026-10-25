// Goal celebration (celebration3d.ts): the scorer's nearest team-mates are drawn running to him in
// the pause the sim holds after a goal, and gather round without standing in each other.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { MOB_GAP, MOB_MAX, MOB_RANGE, MOB_RING, MOB_SPEED, mobBody, planMob } from '../src/client/r3d/celebration3d.ts';
import type { SimBody } from '../src/client/r3d/player3d.ts';
import { GOAL_PAUSE } from '../src/sim/constants.ts';
import { createMatch } from '../src/sim/match.ts';
import type { GoalEvent, MatchState } from '../src/sim/types.ts';

function match(seed: number): MatchState {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return createMatch({ seed, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds: 180, humans: [true, false] });
}

/** Team 0's striker scores at (95, 30), with team-mates at these distances from him. */
function scene(dists: number[]) {
  const s = match(21);
  const mine = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
  const sc = mine[0];
  sc.pos = { x: 95, y: 30 };
  // Everyone else well away, then the chosen few at the given distances, round the scorer.
  for (const p of s.players) if (p !== sc) p.pos = { x: 30, y: 10 + (p.i % 10) * 4 };
  dists.forEach((d, k) => {
    const a = -2 + k * 1.3;
    mine[k + 1].pos = { x: 95 + Math.cos(a) * d, y: 30 + Math.sin(a) * d };
  });
  const goal = { kind: 'goal', tick: 1000, minute: 10, second: 600, team: 0, player: sc.i, scorer: sc.id, ownGoal: false, from: 'play' } as GoalEvent;
  return { s, sc, goal, mine };
}

const body = (): SimBody => ({ pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 } });
const PAUSE = GOAL_PAUSE / 60;

describe('goal celebration', () => {
  test('the nearest team-mates in range run to the scorer, never the keeper or an opponent', () => {
    const { s, sc, goal, mine } = scene([3, 6, 9, 12, 13.5, 20]);
    // An opponent and our keeper right next to him: neither runs.
    s.players.find((p) => p.team === 1)!.pos = { x: 96, y: 30 };
    s.players.find((p) => p.team === 0 && p.role === 'GK')!.pos = { x: 94, y: 31 };
    const plan = planMob(s, goal, false)!;
    expect(plan.scorer).toBe(sc.i);
    expect(plan.runners.length).toBe(MOB_MAX);
    expect(plan.runners.map((r) => r.i).sort()).toEqual([mine[1].i, mine[2].i, mine[3].i].sort());
    for (const r of plan.runners) expect(s.players[r.i].team).toBe(0);
  });

  test('every runner is at the scorer before the pause ends, at a sprint at most, and no two stand closer than MOB_GAP', () => {
    for (const dists of [[2], [4, 4.2, 4.4], [MOB_RANGE, 1, 7], [1, 1.1, 1.2]]) {
      const { s, sc, goal } = scene(dists);
      const plan = planMob(s, goal, false)!;
      const ends = plan.runners.map((r) => {
        let prev = mobBody(r, sc.pos, 0, body()).pos;
        for (let t = 1 / 60; t <= PAUSE + 1e-9; t += 1 / 60) {
          const b = mobBody(r, sc.pos, t, body());
          expect(Math.hypot(b.pos.x - prev.x, b.pos.y - prev.y) * 60).toBeLessThanOrEqual(MOB_SPEED + 1e-6);
          prev = b.pos;
        }
        const end = mobBody(r, sc.pos, PAUSE, body());
        expect(end.vel).toEqual({ x: 0, y: 0 });
        expect(Math.abs(Math.hypot(end.pos.x - sc.pos.x, end.pos.y - sc.pos.y) - MOB_RING)).toBeLessThan(1e-6);
        // Facing the scorer once there.
        expect(end.facing.x * (sc.pos.x - end.pos.x) + end.facing.y * (sc.pos.y - end.pos.y)).toBeGreaterThan(0);
        return end.pos;
      });
      for (let a = 0; a < ends.length; a++) for (let b = a + 1; b < ends.length; b++) expect(Math.hypot(ends[a].x - ends[b].x, ends[a].y - ends[b].y)).toBeGreaterThanOrEqual(MOB_GAP - 1e-6);
    }
  });

  test('before he sets off a runner is where he was, standing', () => {
    const { s, sc, goal } = scene([8]);
    const r = planMob(s, goal, false)!.runners[0];
    const b = mobBody(r, sc.pos, 0.05, body());
    expect(b.pos).toEqual(r.from);
    expect(b.vel).toEqual({ x: 0, y: 0 });
  });

  test('none after an own goal, with nobody in range, or with reduced motion', () => {
    const { s, goal } = scene([3, 5]);
    expect(planMob(s, { ...goal, ownGoal: true }, false)).toBe(null);
    expect(planMob(s, { ...goal, player: -1 }, false)).toBe(null);
    expect(planMob(s, goal, true)).toBe(null);
    const far = scene([MOB_RANGE + 1, 25]);
    expect(planMob(far.s, far.goal, false)).toBe(null);
  });
});
