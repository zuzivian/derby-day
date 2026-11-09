import { expect, test } from 'bun:test';
import { goalOrder, storyWord, type ResultView } from '../src/client/ui.ts';

const g = (team: 0 | 1, second: number, tick = second * 20) => ({ team, second, tick });
const view = (goals: ReturnType<typeof goalOrder> | undefined, gf: number, ga: number, extra: Partial<ResultView> = {}) =>
  ({ gf, ga, goals, forfeited: false, ranked: true, ...extra }) as ResultView;

test('a 90+1 equaliser then a 90+3 winner is a late winner (same clamped minute, true order)', () => {
  const goals = goalOrder([g(0, 600), g(1, 5400), g(0, 5410)]);
  expect(storyWord(view(goals, 2, 1), 'win')).toBe('Late winner');
});

test('a comeback through added time is a comeback', () => {
  const goals = goalOrder([g(1, 600), g(0, 5400), g(0, 5410)]);
  expect(storyWord(view(goals, 2, 1), 'win')).toBe('Comeback');
});

test('goalOrder ignores input order and maps sides', () => {
  expect(goalOrder([g(1, 20), g(0, 10)], 0).map((e) => e.side)).toEqual(['us', 'them']);
  expect(goalOrder([g(1, 20), g(0, 10)], 1).map((e) => e.side)).toEqual(['them', 'us']);
});

test('a late conceded winner in added time is a late blow', () => {
  const goals = goalOrder([g(0, 100), g(1, 5400), g(1, 5410)]);
  expect(storyWord(view(goals, 1, 2), 'loss')).toBe('Late blow');
});

test('a late leveller after trailing', () => {
  const goals = goalOrder([g(1, 100), g(0, 5420)]);
  expect(storyWord(view(goals, 1, 1), 'draw')).toBe('Late leveller');
});

test('missing or mismatched goal times fall back to the plain headline', () => {
  expect(storyWord(view(undefined, 1, 0), 'win')).toBe('Victory');
  expect(storyWord(view(goalOrder([g(0, 10)]), 2, 0), 'win')).toBe('Victory');
  expect(storyWord(view(goalOrder([g(0, 10)]), 1, 0, { pens: { you: 3, opp: 2 } }), 'win')).toBe('Victory');
});

test('derby comes from the stored flag, not the current ladder', () => {
  const goals = goalOrder([g(0, 100), g(0, 200)]);
  expect(storyWord(view(goals, 2, 0, { derby: true }), 'win')).toBe('Derby win');
  const lost = goalOrder([g(1, 100)]);
  expect(storyWord(view(lost, 0, 1, { derby: true }), 'loss')).toBe('Derby loss');
  expect(storyWord(view(lost, 0, 1, { derby: false }), 'loss')).toBe('Defeat');
});
