import { describe, expect, test } from 'bun:test';
import { fullTimeMoment, goalMoment } from '../src/client/moments.ts';
import type { GoalEvent } from '../src/sim/types.ts';

const g = (team: 0 | 1, minute: number, scorer = `P${team}`, ownGoal = false): GoalEvent => ({ kind: 'goal', tick: 0, minute, second: minute * 60, team, player: 0, scorer, ownGoal, from: 'play' });
const last = (gs: GoalEvent[], x = {}) => goalMoment(gs, gs.length - 1, x);

describe('goalMoment', () => {
  test('an ordinary goal is nothing', () => {
    expect(last([g(0, 10)])).toBeNull();
    expect(last([g(0, 10), g(0, 30)])).toBeNull();
    expect(last([g(0, 10), g(1, 20), g(0, 40)])).toBeNull();
  });
  test('a late winner: from level, 85th minute on', () => {
    expect(last([g(0, 20), g(1, 50), g(0, 88)])).toEqual({ word: 'Late winner!', level: 2 });
    expect(last([g(0, 84)])).toBeNull();
    expect(last([g(0, 10), g(0, 86)])).toBeNull(); // 1-0 up already: not a winner
  });
  test('an equaliser from the 60th minute; a late one is bigger', () => {
    expect(last([g(1, 10), g(0, 65)])).toEqual({ word: 'Equaliser!', level: 1 });
    expect(last([g(1, 10), g(0, 40)])).toBeNull();
    expect(last([g(1, 10), g(0, 90)])).toEqual({ word: 'Late equaliser!', level: 2 });
  });
  test('a hat-trick is the third goal by one scorer, not own goals or a fourth', () => {
    const gs = [g(0, 5, 'A'), g(0, 20, 'A'), g(0, 40, 'A')];
    expect(last(gs)).toEqual({ word: 'Hat-trick!', level: 2 });
    expect(last([...gs, g(0, 60, 'A')])).toBeNull();
    expect(last([g(0, 5, 'A'), g(0, 20, 'A'), g(0, 40, 'A', true)])).toBeNull();
    expect(last([g(0, 5, 'A'), g(1, 8, 'A'), g(0, 20, 'A')])).toBeNull(); // the other side's A is not his
  });
  test('a comeback: from two down to level or ahead', () => {
    expect(last([g(1, 5), g(1, 20), g(0, 40)])).toBeNull(); // 1-2: still behind
    expect(last([g(1, 5), g(1, 20), g(0, 40, 'B'), g(0, 50, 'C')])).toEqual({ word: 'Comeback!', level: 2 });
    expect(last([g(1, 5), g(1, 20), g(0, 40, 'B'), g(0, 50, 'C'), g(0, 70, 'D')])).toEqual({ word: 'Comeback!', level: 2 });
  });
  test('a screamer needs a seen shot from 24 m or more', () => {
    expect(last([g(0, 10)], { dist: 27 })).toEqual({ word: 'Screamer!', level: 1 });
    expect(last([g(0, 10)], { dist: 18 })).toBeNull();
    expect(last([g(0, 10, 'A', true)], { dist: 30 })).toBeNull();
  });
  test('a derby goal only when it changes who is ahead', () => {
    expect(last([g(0, 10)], { derby: true })).toEqual({ word: 'Derby goal!', level: 1 });
    expect(last([g(0, 10), g(0, 30)], { derby: true })).toBeNull();
    expect(last([g(1, 10), g(0, 30)], { derby: true })).toEqual({ word: 'Derby goal!', level: 1 });
  });
  test('the bigger moment wins', () => {
    expect(last([g(0, 5, 'A'), g(0, 20, 'A'), g(0, 88, 'A')], { derby: true, dist: 30 })?.word).toBe('Hat-trick!');
    expect(last([g(1, 10), g(0, 30)], { derby: true, dist: 30 })?.word).toBe('Screamer!');
  });
});

describe('fullTimeMoment', () => {
  test('a cup final or derby win names itself, a clean sheet is flagged', () => {
    expect(fullTimeMoment([2, 0], 0, { final: true, derby: true })).toEqual({ word: 'Cup final won!', clean: true });
    expect(fullTimeMoment([1, 0], 0, { derby: true })).toEqual({ word: 'Derby won!', clean: true });
    expect(fullTimeMoment([3, 1], 0, {})).toEqual({ word: 'Full time', clean: false });
    expect(fullTimeMoment([0, 2], 1, { final: true }).word).toBe('Cup final won!');
  });
  test('draws and defeats stay plain; a 0–0 is not a clean-sheet win', () => {
    expect(fullTimeMoment([0, 0], 0, { final: true, derby: true })).toEqual({ word: 'Full time', clean: false });
    expect(fullTimeMoment([0, 1], 0, { final: true })).toEqual({ word: 'Full time', clean: false });
  });
});
