import { describe, expect, test } from 'bun:test';
import { stingerLength, stingerNotes } from '../src/client/audio.ts';
import { winStreak } from '../src/client/home.ts';
import { rankedNote } from '../src/client/ui.ts';

const m = (gf: number, ga: number) => ({ goalsFor: gf, goalsAgainst: ga });

describe('repeat-play helpers', () => {
  test('winStreak counts trailing wins only', () => {
    expect(winStreak([])).toBe(0);
    expect(winStreak([m(1, 0), m(2, 2)])).toBe(0);
    expect(winStreak([m(0, 1), m(1, 0), m(3, 1), m(2, 0), m(1, 0), m(4, 0), m(1, 0)])).toBe(6);
  });
  test('rankedNote words a loss or draw and points to Training when it is open', () => {
    expect(rankedNote(1, 2, 2, true)).toBe('So close. Your 2 training sessions are waiting in Training.');
    expect(rankedNote(1, 1, 1, true)).toBe('A point shared. Your 1 training session is waiting in Training.');
    expect(rankedNote(0, 3, 2, false)).toBe('Not this time. The prize money and XP are yours either way.');
  });
  test('rankedNote offers a next step after a heavy defeat, only when Squad is open', () => {
    const step = 'Not this time. Try High press from Pause, or rework the XI in Squad.';
    expect(rankedNote(0, 3, 2, true, true)).toBe(`${step} Your 2 training sessions are waiting in Training.`);
    expect(rankedNote(1, 5, 0, true, true)).toBe(`${step} The prize money and XP are yours either way.`);
    expect(rankedNote(0, 3, 2, false, false)).toBe('Not this time. The prize money and XP are yours either way.');
    // Narrow defeats and draws keep their short leads even with Squad open.
    expect(rankedNote(1, 2, 0, false, true)).toBe('So close. The prize money and XP are yours either way.');
    expect(rankedNote(2, 2, 0, false, true)).toBe('A point shared. The prize money and XP are yours either way.');
    expect(rankedNote(0, 2, 0, false, true)).toBe('Not this time. The prize money and XP are yours either way.');
  });
  test('train and cup stingers: short cue, and a trophy bigger than a win', () => {
    expect(stingerNotes('train').length).toBe(2);
    expect(stingerLength('train')).toBeLessThan(0.6);
    expect(stingerLength('cup')).toBeGreaterThan(stingerLength('win'));
    expect(stingerNotes('cup').length).toBeGreaterThan(stingerNotes('win').length);
  });
});
