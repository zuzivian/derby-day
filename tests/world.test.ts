import { describe, expect, test } from 'bun:test';
import { ladderSquad, slotRating, SQUAD_ROLES } from '../src/meta/club.ts';
import { cupOpponent, pickEntrants, prizeIn, recordCupMatch, recordSeasonMatch, SEASON_PRIZES, startCup, startSeason, type QuickSim } from '../src/meta/competitions.ts';
import { averageOverall, isSave, newGame as freshGame, type Save } from '../src/meta/game.ts';
import { totalXpForLevel } from '../src/meta/levels.ts';
import { runRollover } from '../src/meta/progression.ts';
import {
  applyLeagueFinish,
  cpuStrength,
  developWorld,
  DIVISION_QUALITY,
  DIVISION_SIZE,
  DIVISIONS,
  divisionClubs,
  ensureWorldFields,
  generateWorld,
  playerDivision,
  quickScore,
  WORLD_CPU_CLUBS,
} from '../src/meta/world.ts';
import { makeRng } from '../src/sim/rng.ts';

/** A club at level 10, where the season calendar runs. */
function newGame(seed: number): Save {
  const s = freshGame(seed);
  s.xp = totalXpForLevel(10);
  return s;
}

const sizes = (s: Save) => Array.from({ length: DIVISIONS }, (_, k) => divisionClubs(s, k + 1).length + (playerDivision(s) === k + 1 ? 1 : 0));
const meanQuality = (s: Save, d: number) => divisionClubs(s, d).reduce((t, c) => t + c.quality, 0) / divisionClubs(s, d).length;
/** Your XI forced to a level, by setting every starter's attributes. */
function setXi(s: Save, level: number): void {
  for (const id of s.lineup) {
    const p = s.squad.find((x) => x.id === id)!;
    for (const k of Object.keys(p.attrs) as (keyof typeof p.attrs)[]) p.attrs[k] = level;
  }
}
/** The first club always wins 1-0. */
const homeWins: QuickSim = () => ({ ga: 1, gb: 0 });

describe('a new world', () => {
  test('31 CPU clubs in four divisions of eight with you at the bottom, each squad level with its division', () => {
    const s = newGame(1);
    expect(s.ladder.length).toBe(WORLD_CPU_CLUBS);
    expect(playerDivision(s)).toBe(DIVISIONS);
    expect(sizes(s)).toEqual([DIVISION_SIZE, DIVISION_SIZE, DIVISION_SIZE, DIVISION_SIZE]);
    for (let d = 1; d <= DIVISIONS; d++) expect(Math.abs(meanQuality(s, d) - DIVISION_QUALITY[d - 1])).toBeLessThan(3);
    expect(new Set(s.ladder.map((c) => c.name)).size).toBe(WORLD_CPU_CLUBS);
    // The strongest CPU XI is far above a new club's: the ladder has somewhere to go.
    expect(Math.max(...s.ladder.map(cpuStrength))).toBeGreaterThan(averageOverall(s) + 25);
  });

  test('is the same from the same seed, and squads rebuild to the same players every time', () => {
    expect(JSON.stringify(generateWorld(77))).toBe(JSON.stringify(generateWorld(77)));
    expect(JSON.stringify(generateWorld(77))).not.toBe(JSON.stringify(generateWorld(78)));
    const c = newGame(3).ladder[5];
    const a = ladderSquad(c);
    const b = ladderSquad(c);
    expect(a.map((p) => [p.id, p.first, p.last, p.age, p.attrs])).toEqual(b.map((p) => [p.id, p.first, p.last, p.age, p.attrs]));
    expect(a.map((p) => p.role)).toEqual(SQUAD_ROLES);
    expect(new Set(a.map((p) => p.id)).size).toBe(a.length);
  });

  test('a CPU XI sits about at its club quality', () => {
    const s = newGame(4);
    const gaps = s.ladder.map((c) => cpuStrength(c) - c.quality);
    const mean = gaps.reduce((t, g) => t + g, 0) / gaps.length;
    expect(Math.abs(mean)).toBeLessThan(3);
  });
});

describe('the world season', () => {
  test('CPU players age a year, veterans retire for academy youngsters, and the same player is still there', () => {
    const s = newGame(5);
    const c = s.ladder[0];
    const before = c.slots!.map((x) => [...x]);
    developWorld(s, makeRng(9));
    let kept = 0;
    let youth = 0;
    c.slots!.forEach((slot, i) => {
      if (slot[0] === before[i][0]) {
        kept++;
        expect(slot[1]).toBe(before[i][1] + 1);
      } else if (slot[1] <= 19) youth++;
    });
    // Most stay; anyone replaced in the same place left by retirement (youth) or a transfer.
    expect(kept).toBeGreaterThan(12);
    expect(kept + youth).toBeGreaterThan(14);
  });

  test('over 40 seasons nobody plays past 40 and every squad keeps 18', () => {
    const s = newGame(6);
    const r = makeRng(6);
    for (let y = 0; y < 40; y++) developWorld(s, r);
    for (const c of s.ladder) {
      expect(c.slots!.length).toBe(SQUAD_ROLES.length);
      expect(Math.max(...c.slots!.map((x) => x[1]))).toBeLessThanOrEqual(40);
    }
  });

  test('two up and two down between CPU divisions, and every division keeps eight', () => {
    const s = newGame(7);
    const w = developWorld(s, makeRng(7));
    expect(w.promoted.length).toBe(2 * (DIVISIONS - 1));
    expect(w.relegated.length).toBe(2 * (DIVISIONS - 1));
    expect(sizes(s)).toEqual([8, 8, 8, 8]);
    for (const m of w.promoted) expect(m.to).toBe(m.from - 1);
    // Your own division's CPU table crowns nobody: your league decides it.
    expect(w.champions.map((x) => x.division)).not.toContain(playerDivision(s));
  });

  test('is deterministic: the same save develops the same way', () => {
    const a = newGame(8);
    const b = JSON.parse(JSON.stringify(a)) as Save;
    developWorld(a, makeRng(1));
    developWorld(b, makeRng(1));
    expect(JSON.stringify(a.ladder)).toBe(JSON.stringify(b.ladder));
  });

  test('the pyramid holds over 50 seasons, and the top rises with a great XI', () => {
    const s = newGame(9);
    const r = makeRng(9);
    for (let y = 0; y < 50; y++) developWorld(s, r);
    const means = [1, 2, 3, 4].map((d) => meanQuality(s, d));
    expect(means[0]).toBeGreaterThan(means[1]);
    expect(means[1]).toBeGreaterThan(means[2]);
    expect(means[2]).toBeGreaterThan(means[3]);
    const topBefore = Math.max(...s.ladder.map((c) => c.quality));
    setXi(s, 90); // about the best XI a club can build (potential tops out at 95)
    expect(averageOverall(s)).toBeGreaterThan(86);
    for (let y = 0; y < 15; y++) developWorld(s, r);
    const topAfter = Math.max(...s.ladder.map((c) => c.quality));
    expect(topAfter).toBeGreaterThanOrEqual(topBefore + 3);
    expect(topAfter).toBeGreaterThanOrEqual(averageOverall(s) - 4);
  });

  test('a rollover writes the world into the season review and the club history', () => {
    const s = newGame(10);
    const review = runRollover(s);
    expect(review.world!.promoted.length).toBeGreaterThan(0);
    expect(review.world!.topQuality).toBeGreaterThan(80);
    expect(s.seasons!.length).toBe(1);
    expect(s.seasons![0]).toMatchObject({ year: 1, division: DIVISIONS });
  });
});

describe('your league finish', () => {
  test('the top two go up and the bottom two go down, swapping places with a CPU club', () => {
    const s = newGame(11);
    const up = applyLeagueFinish(s, 1);
    expect(up.moved).toBe('up');
    expect(playerDivision(s)).toBe(3);
    expect(sizes(s)).toEqual([8, 8, 8, 8]);
    expect(divisionClubs(s, 4).some((c) => c.name === up.swapped)).toBe(true);
    expect(applyLeagueFinish(s, 4).moved).toBeNull();
    expect(applyLeagueFinish(s, 8).moved).toBe('down');
    expect(playerDivision(s)).toBe(4);
    // Nowhere to fall from the bottom, nowhere to rise from the top.
    expect(applyLeagueFinish(s, 8).moved).toBeNull();
    s.division = 1;
    ensureWorldFields(s);
    expect(applyLeagueFinish(s, 1).moved).toBeNull();
  });

  test('the league is your division; winning it promotes you and pays the division rate', () => {
    const s = newGame(12);
    startSeason(s);
    expect(s.season!.entrants.filter((id) => id !== s.club.id).every((id) => s.ladder.find((c) => c.id === id)!.division === 4)).toBe(true);
    let out;
    const before = s.budget;
    for (let d = 0; d < 7; d++) out = recordSeasonMatch(s, 3, 0, [], homeWins);
    expect(s.season!.finish).toBe(1);
    expect(s.season!.moved).toBe('up');
    expect(out!.note).toContain('Promoted to Division 3');
    expect(s.budget - before).toBe(SEASON_PRIZES[0]);
    expect(s.records!.bestDivision).toBe(3);
    // The next league is in Division 3 and pays its rate.
    s.season = null;
    startSeason(s);
    expect(s.season!.division).toBe(3);
    const b2 = s.budget;
    for (let d = 0; d < 7; d++) recordSeasonMatch(s, 3, 0, [], homeWins);
    expect(s.budget - b2).toBe(prizeIn(SEASON_PRIZES[0], 3));
    expect(prizeIn(SEASON_PRIZES[0], 3)).toBeGreaterThan(SEASON_PRIZES[0]);
  });

  test('a cup mixes your division with three clubs from the one above', () => {
    const s = newGame(13);
    const ids = pickEntrants(s, 'cup').filter((id) => id !== s.club.id);
    const divs = ids.map((id) => s.ladder.find((c) => c.id === id)!.division);
    expect(divs.filter((d) => d === 4).length).toBe(4);
    expect(divs.filter((d) => d === 3).length).toBe(3);
    startCup(s);
    expect(cupOpponent(s, s.cup!)).not.toBeNull();
    recordCupMatch(s, 1, 0, [], homeWins);
    expect(s.cup!.round).toBe(1);
  });
});

describe('CPU fixture scores', () => {
  test('equal XIs: about 2.6 goals a match and a quarter drawn; the stronger side wins more', () => {
    const r = makeRng(42);
    let goals = 0;
    let draws = 0;
    const n = 4000;
    for (let k = 0; k < n; k++) {
      const [a, b] = quickScore(r, 70, 70);
      goals += a + b;
      if (a === b) draws++;
    }
    expect(goals / n).toBeGreaterThan(2.4);
    expect(goals / n).toBeLessThan(2.8);
    expect(draws / n).toBeGreaterThan(0.2);
    expect(draws / n).toBeLessThan(0.3);
    let strongWins = 0;
    for (let k = 0; k < n; k++) {
      const [a, b] = quickScore(r, 76, 70);
      if (a > b) strongWins++;
    }
    expect(strongWins / n).toBeGreaterThan(0.5);
    expect(strongWins / n).toBeLessThan(0.8);
  });
});

describe('saves from before the world', () => {
  /** A save as the 15-club ladder wrote it: no divisions, no squad slots, no division of your own. */
  function oldSave(seed: number): Save {
    const s = newGame(seed);
    s.ladder = s.ladder.slice(0, 15).map((c, i) => {
      const { division: _d, slots: _s, ambition: _a, ...rest } = c;
      return { ...rest, quality: 44 + i * 2, elo: 900 + i * 25 };
    });
    delete s.division;
    return JSON.parse(JSON.stringify(s));
  }

  test('keep every club as it was, gain the rest of the pyramid, and are placed by their XI', () => {
    const s = oldSave(20);
    const before = s.ladder.map((c) => [c.id, c.name, c.elo, c.quality, c.played]);
    expect(isSave(s)).toBe(true);
    ensureWorldFields(s);
    expect(s.ladder.length).toBe(WORLD_CPU_CLUBS);
    expect(s.ladder.slice(0, 15).map((c) => [c.id, c.name, c.elo, c.quality, c.played])).toEqual(before);
    expect(sizes(s)).toEqual([8, 8, 8, 8]);
    expect(playerDivision(s)).toBe(4); // a new club's XI of about 54
    expect(s.ladder.every((c) => c.slots!.length === SQUAD_ROLES.length)).toBe(true);
    expect(s.news.at(-1)).toContain('pyramid');
  });

  test('a strong old club starts higher up', () => {
    const s = oldSave(21);
    setXi(s, 85);
    ensureWorldFields(s);
    expect(playerDivision(s)).toBeLessThanOrEqual(2);
    expect(sizes(s)).toEqual([8, 8, 8, 8]);
  });

  test('migration is idempotent, round-trips through JSON and keeps a cup in progress playable', () => {
    const s = oldSave(22);
    startCup(s); // startCup migrates first
    const once = JSON.stringify(s);
    ensureWorldFields(s);
    expect(JSON.stringify(s)).toBe(once);
    const back = JSON.parse(once) as Save;
    expect(isSave(back)).toBe(true);
    expect(recordCupMatch(back, 2, 0, [], homeWins).note.length).toBeGreaterThan(0);
  });

  test('isSave rejects a malformed division', () => {
    const s = newGame(23) as unknown as Record<string, unknown>;
    s.division = 'top';
    expect(isSave(s)).toBe(false);
  });
});

describe('slot ratings', () => {
  test('youngsters and veterans sit below their club, the prime at it, the reserve keeper lower', () => {
    expect(slotRating(70, 3, [1, 18, 0])).toBeLessThan(70);
    expect(slotRating(70, 3, [1, 26, 0])).toBe(70);
    expect(slotRating(70, 3, [1, 34, 0])).toBeLessThan(65);
    expect(slotRating(70, 1, [1, 26, 0])).toBe(64);
  });
});
