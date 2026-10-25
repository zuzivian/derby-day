// Goal celebration (celebration3d.ts): in the pause the sim holds after a goal the scorer is drawn
// running off toward the nearest corner flag, and his nearest team-mates running to where he stops
// and gathering round without standing in each other.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { FLAG_CLEAR, MOB_GAP, MOB_MAX, MOB_RANGE, MOB_RING, MOB_SPEED, RUN_OFF, RUN_SPEED, mobBody, planMob, scorerBody } from '../src/client/r3d/celebration3d.ts';
import type { SimBody } from '../src/client/r3d/player3d.ts';
import { GOAL_PAUSE, PITCH_H, PITCH_W } from '../src/sim/constants.ts';
import { createMatch } from '../src/sim/match.ts';
import type { GoalEvent, MatchState } from '../src/sim/types.ts';
import type { Vec } from '../src/sim/vec.ts';

function match(seed: number): MatchState {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return createMatch({ seed, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds: 180, humans: [true, false] });
}

const body = (): SimBody => ({ pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 } });
const PAUSE = GOAL_PAUSE / 60;

/** Team 0's striker scores at x = PITCH_W from `at`; team-mates at these distances from where his run-off ends. */
function scene(dists: number[], at: Vec = { x: 95, y: 30 }) {
  const s = match(21);
  const mine = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
  const sc = mine[0];
  sc.pos = { ...at };
  s.ball.pos = { x: PITCH_W - 0.5, y: PITCH_H / 2 };
  // Everyone else well away at first.
  for (const p of s.players) if (p !== sc) p.pos = { x: 20, y: 6 + (p.i % 12) * 5 };
  const goal = { kind: 'goal', tick: 1000, minute: 10, second: 600, team: 0, player: sc.i, scorer: sc.id, ownGoal: false, from: 'play' } as GoalEvent;
  const end = planMob(s, goal, false)!.run.to;
  dists.forEach((d, k) => {
    const a = 1.2 + k * 1.3;
    mine[k + 1].pos = { x: end.x + Math.cos(a) * d, y: end.y + Math.sin(a) * d };
  });
  return { s, sc, goal, mine, end };
}

/** Every 1/60 s through the pause: the step never faster than `cap`, m/s. */
function track(at: (t: number) => SimBody, cap: number): SimBody {
  let prev = at(0).pos;
  for (let t = 1 / 60; t <= PAUSE + 1e-9; t += 1 / 60) {
    const b = at(t);
    expect(Math.hypot(b.pos.x - prev.x, b.pos.y - prev.y) * 60).toBeLessThanOrEqual(cap + 1e-6);
    prev = b.pos;
  }
  return at(PAUSE);
}

describe('goal celebration', () => {
  test('the scorer runs off toward the nearest corner flag, then turns back to the pitch, all inside the pause', () => {
    for (const [at, flagY] of [
      [{ x: 95, y: 30 }, 0],
      [{ x: 90, y: 50 }, PITCH_H],
      [{ x: 102, y: 3 }, 0],
    ] as [Vec, number][]) {
      const { s, sc, goal } = scene([], at);
      const plan = planMob(s, goal, false)!;
      expect(plan.scorer).toBe(sc.i);
      const flag = { x: PITCH_W, y: flagY };
      const run = Math.hypot(plan.run.to.x - at.x, plan.run.to.y - at.y);
      expect(run).toBeLessThanOrEqual(RUN_OFF + 1e-9);
      expect(Math.hypot(flag.x - plan.run.to.x, flag.y - plan.run.to.y)).toBeGreaterThanOrEqual(FLAG_CLEAR - 1e-9);
      // Toward the flag, not away from it.
      expect(Math.hypot(flag.x - plan.run.to.x, flag.y - plan.run.to.y)).toBeLessThanOrEqual(Math.hypot(flag.x - at.x, flag.y - at.y) + 1e-9);
      const end = track((t) => scorerBody(plan, t, body()), RUN_SPEED);
      expect(end.pos).toEqual(plan.run.to);
      expect(end.vel).toEqual({ x: 0, y: 0 });
      // Facing back across the pitch.
      expect(end.facing.x * (PITCH_W / 2 - end.pos.x) + end.facing.y * (PITCH_H / 2 - end.pos.y)).toBeGreaterThan(0);
    }
  });

  test('the nearest team-mates to where he stops run to him, never the keeper or an opponent', () => {
    const { s, goal, mine, end } = scene([3, 6, 9, 12, 12.5, 20]);
    s.players.find((p) => p.team === 1)!.pos = { x: end.x + 1, y: end.y };
    s.players.find((p) => p.team === 0 && p.role === 'GK')!.pos = { x: end.x - 1, y: end.y };
    const plan = planMob(s, goal, false)!;
    expect(plan.runners.length).toBe(MOB_MAX);
    expect(plan.runners.map((r) => r.i).sort()).toEqual([mine[1].i, mine[2].i, mine[3].i].sort());
  });

  test('every runner is round him before the pause ends, at a sprint at most, and no two stand closer than MOB_GAP', () => {
    for (const dists of [[2], [4, 4.2, 4.4], [MOB_RANGE - 0.01, 1, 7], [1, 1.1, 1.2]]) {
      const { s, goal } = scene(dists);
      const plan = planMob(s, goal, false)!;
      expect(plan.runners.length).toBe(dists.length);
      const c = plan.run.to;
      const ends = plan.runners.map((r) => {
        const end = track((t) => mobBody(plan, r, t, body()), MOB_SPEED);
        expect(end.vel).toEqual({ x: 0, y: 0 });
        expect(Math.abs(Math.hypot(end.pos.x - c.x, end.pos.y - c.y) - MOB_RING)).toBeLessThan(1e-6);
        expect(end.facing.x * (c.x - end.pos.x) + end.facing.y * (c.y - end.pos.y)).toBeGreaterThan(0);
        return end.pos;
      });
      for (let a = 0; a < ends.length; a++) for (let b = a + 1; b < ends.length; b++) expect(Math.hypot(ends[a].x - ends[b].x, ends[a].y - ends[b].y)).toBeGreaterThanOrEqual(MOB_GAP - 1e-6);
    }
  });

  test('before he sets off a runner is where he was, standing', () => {
    const { s, goal } = scene([8]);
    const plan = planMob(s, goal, false)!;
    const r = plan.runners[0];
    const b = mobBody(plan, r, 0.05, body());
    expect(b.pos).toEqual(r.from);
    expect(b.vel).toEqual({ x: 0, y: 0 });
  });

  test('nobody near: he still runs off alone; none at all after an own goal or with reduced motion', () => {
    const far = scene([MOB_RANGE + 1, 25]);
    const alone = planMob(far.s, far.goal, false)!;
    expect(alone.runners).toEqual([]);
    const { s, goal } = scene([3, 5]);
    expect(planMob(s, { ...goal, ownGoal: true }, false)).toBe(null);
    expect(planMob(s, { ...goal, player: -1 }, false)).toBe(null);
    expect(planMob(s, goal, true)).toBe(null);
  });
});
