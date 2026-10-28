// A penalty in a match is the shootout's kick (sim/penalty.ts): the human's aim and power, or the CPU's choice,
// against the keeper's dive, decided by resolveKick, and the ball and keeper then do what it decided. So a placed
// kick scores about as often as it would in a shootout, down the middle is saved about as often, and a blast
// past the sweet spot can go over.

import { describe, expect, test } from 'bun:test';
import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { GOAL_BAR_H, GOAL_W, PITCH_H } from '../src/sim/constants.ts';
import { goalkeeper, oppGoal } from '../src/sim/field.ts';
import { createMatch, humanPenaltyAim, step } from '../src/sim/match.ts';
import { cpuKeeperDive, cpuTakerAim, resolveKick, type KickOutcome } from '../src/sim/penalty.ts';
import { makeRng } from '../src/sim/rng.ts';
import { awardRestart } from '../src/sim/rules.ts';
import type { HumanInput, MatchState } from '../src/sim/types.ts';
import { kickOff } from './helpers.ts';

const MID = PITCH_H / 2;

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  return { home: { ...cpuTeam(a, ladderSquad(a)), formation: '4-4-2' as const }, away: { ...cpuTeam(b, ladderSquad(b)), formation: '4-4-2' as const } };
}

const still = (s: MatchState): HumanInput => ({ cursor: { ...s.players[s.controlled[0]].pos } });

/** A penalty to side 0 (the human's, unless `cpu`), at the first tick it can be taken. */
function penalty(seed: number, cpu = false): MatchState {
  const s = createMatch({ seed, ...teams(7 + (seed % 5) * 2), halfSeconds: 900, humanTeam: 0 });
  kickOff(s);
  if (cpu) s.humans = [false, false];
  const g = oppGoal(s, 0);
  awardRestart(s, 'penalty', 0, { x: g.x - Math.sign(g.x - 52.5) * 11, y: MID }, 'foul');
  for (let n = 0; n < 900 && s.restart && s.restart.stage !== 'ready'; n++) step(s, still(s));
  return s;
}

/** How it ended: in, held or parried first by the keeper, or out over or wide, or back off the woodwork into play. */
function playOut(s: MatchState): KickOutcome | 'none' {
  const taker = s.ball.penalty!.by;
  const gk = s.ball.penalty!.gk;
  const g0 = s.score[0];
  const lineX = oppGoal(s, 0).x;
  // Its height as it crossed the goal line: the goal kick is given a few ticks later, when it has dropped.
  let zLine = -1;
  for (let t = 0; t < 240; t++) {
    if (s.score[0] > g0) return 'goal';
    const lt = s.ball.lastTouch;
    if (lt === gk) return 'saved';
    // Over the bar, or wide of the post below its height (one just wide at 2.2 m is wide).
    if (s.restart) return s.restart.kind === 'goalkick' ? (zLine > GOAL_BAR_H ? 'over' : 'wide') : 'none';
    if (lt !== taker && lt >= 0) return 'post';
    const before = s.ball.pos.x;
    step(s, still(s));
    if (zLine < 0 && (before - lineX) * (s.ball.pos.x - lineX) <= 0) zLine = s.ball.z;
  }
  return 'post';
}

describe('a penalty in a match is the shootout kick', () => {
  test('it ends as the kick decided: in, saved, wide, over, or off the woodwork', () => {
    const seen = new Set<string>();
    let n = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const [across, power] of [
        [0.95, 0.6],
        [0, 0.6],
        [0.7, 0.95],
        [1.1, 0.7],
      ]) {
        const s = penalty(seed);
        const at = { x: oppGoal(s, 0).x, y: MID + (seed % 2 ? 1 : -1) * across * (GOAL_W / 2) };
        step(s, { cursor: at, aim: at, shoot: power, moved: true });
        const fate = s.ball.penalty!.fate;
        const out = playOut(s);
        n++;
        seen.add(fate);
        // Off the woodwork it comes back into play: whoever gets it first, it's no goal.
        if (fate === 'post') expect(out === 'goal' || out === 'wide' || out === 'over').toBe(false);
        else expect(out).toBe(fate);
      }
    }
    expect(n).toBe(160);
    for (const f of ['goal', 'saved', 'wide', 'over', 'post']) expect(seen.has(f)).toBe(true);
  });

  for (const [name, across, power, what] of [
    ['a kick placed by the post at sweet-spot power scores about as often as in a shootout', 0.8, 0.65, 'goal'],
    ['one down the middle is saved about as often as in a shootout', 0, 0.65, 'saved'],
    ['one struck past the sweet spot goes over about as often as in a shootout', 0.6, 0.95, 'over'],
  ] as const) {
    test(name, () => {
      let got = 0;
      let expected = 0;
      const N = 60;
      for (let seed = 1; seed <= N; seed++) {
        const s = penalty(seed);
        const at = { x: oppGoal(s, 0).x, y: MID + (seed % 2 ? 1 : -1) * across * (GOAL_W / 2) };
        const taker = s.players[s.restart!.taker];
        const gk = goalkeeper(s, 1);
        // The shootout's odds for this taker, this keeper and this kick.
        const aim = humanPenaltyAim(s, 0, s.restart!.spot, at, power);
        const r = makeRng(seed * 7919);
        let hits = 0;
        for (let i = 0; i < 400; i++) {
          const dive = cpuKeeperDive(r, gk.attrs.goalkeeping, aim);
          if (resolveKick(r, { aim, power, shooting: taker.attrs.shooting, goalkeeping: gk.attrs.goalkeeping, dive }).outcome === what) hits++;
        }
        expected += hits / 400;
        step(s, { cursor: at, aim: at, shoot: power, moved: true });
        if (playOut(s) === what) got++;
      }
      // Within the scatter of 60 kicks.
      expect(Math.abs(got / N - expected / N)).toBeLessThan(0.13);
    });
  }

  test('placed by the post it is no longer a certain goal, and down the middle no longer a likely save', () => {
    const rate = (across: number, what: string) => {
      let k = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const s = penalty(seed);
        const at = { x: oppGoal(s, 0).x, y: MID + (seed % 2 ? 1 : -1) * across * (GOAL_W / 2) };
        step(s, { cursor: at, aim: at, shoot: 0.65, moved: true });
        if (playOut(s) === what) k++;
      }
      return k / 40;
    };
    // Before, 97-100% of these went in, and 68-73% down the middle were saved.
    expect(rate(0.8, 'goal')).toBeLessThan(0.92);
    expect(rate(0, 'saved')).toBeLessThan(0.62);
  });

  test("the CPU's in-match penalty is its shootout kick: about the same rate", () => {
    let scored = 0;
    let expected = 0;
    const N = 60;
    for (let seed = 1; seed <= N; seed++) {
      const s = penalty(seed, true);
      const taker = s.players[s.restart!.taker];
      const gk = goalkeeper(s, 1);
      const r = makeRng(seed * 104729);
      let hits = 0;
      for (let i = 0; i < 400; i++) {
        const { aim, power } = cpuTakerAim(r, taker.attrs.shooting);
        const dive = cpuKeeperDive(r, gk.attrs.goalkeeping, aim);
        if (resolveKick(r, { aim, power, shooting: taker.attrs.shooting, goalkeeping: gk.attrs.goalkeeping, dive }).scored) hits++;
      }
      expected += hits / 400;
      for (let t = 0; t < 600 && s.restart?.kind === 'penalty'; t++) step(s, still(s));
      if (playOut(s) === 'goal') scored++;
    }
    expect(Math.abs(scored / N - expected / N)).toBeLessThan(0.13);
  });
});
