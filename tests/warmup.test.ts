import { describe, expect, test } from 'bun:test';
import { newGame } from '../src/meta/game.ts';
import { totalXpForLevel } from '../src/meta/levels.ts';
import { FIRST_MATCH, rankedOpen, showGauge, WARMUP, warmupIdentity, warmupTeam } from '../src/meta/warmup.ts';
import { setClubName } from '../src/meta/identity.ts';
import type { MatchRecord } from '../src/meta/game.ts';

const rec = (ranked: boolean): MatchRecord => ({ opponent: 'A', opponentShort: 'A', goalsFor: 1, goalsAgainst: 0, ranked, eloBefore: 1000, eloAfter: 1000, scorers: [] });

describe('warm-up friendly', () => {
  test('ranked opens at level 3; before it Kick off is a warm-up', () => {
    const s = newGame(1);
    expect(rankedOpen(s)).toBe(false);
    s.xp = totalXpForLevel(2);
    expect(rankedOpen(s)).toBe(false);
    s.xp = totalXpForLevel(3);
    expect(rankedOpen(s)).toBe(true);
  });

  test('the opponent is stable until a match is played, then a new club, and is the same club the match uses', () => {
    const s = newGame(2);
    const a = warmupIdentity(s);
    expect(warmupIdentity(s)).toEqual(a);
    expect(warmupTeam(s).id).toEqual(a);
    s.history.push(rec(false));
    expect(warmupIdentity(s).name).not.toBe(a.name);
  });

  test('the squad is gentle: quality about 50, CPU skill 0.25; the first match is gentler still', () => {
    const s = newGame(3);
    expect(WARMUP.quality).toBeLessThanOrEqual(50);
    expect(WARMUP.aiSkill).toBeLessThanOrEqual(0.3);
    expect(FIRST_MATCH.aiSkill).toBeLessThan(WARMUP.aiSkill);
    expect(warmupTeam(s).away.aiSkill).toBe(WARMUP.aiSkill);
    expect(warmupTeam(s, true).away.aiSkill).toBe(FIRST_MATCH.aiSkill);
    expect(warmupTeam(s, true).id.name).toBe(warmupIdentity(s, true).name);
    expect(warmupTeam(s).away.players.length).toBe(11);
  });

  test('the win-chance gauge stays hidden for the first three ranked matches', () => {
    const s = newGame(4);
    expect(showGauge(s)).toBe(false);
    s.history.push(rec(true), rec(false), rec(true));
    expect(showGauge(s)).toBe(false); // only two ranked so far
    s.history.push(rec(true));
    expect(showGauge(s)).toBe(true); // the third ranked match is behind us
  });
});

describe('renaming later', () => {
  test('a club can be renamed after matches have been played, with a new short code', () => {
    const s = newGame(5);
    s.club.played = 12;
    expect(setClubName(s, '  Harbour   Lights ')).toBe(true);
    expect(s.club.name).toBe('Harbour Lights');
    expect(s.club.short).toBe('HLI');
    expect(setClubName(s, 'x')).toBe(false);
    expect(s.club.name).toBe('Harbour Lights');
  });
});
