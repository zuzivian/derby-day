import { describe, expect, test } from 'bun:test';
import { canStart, closeCup, cupOpponent, cupWaitLeft, pickEntrants, recordCupMatch, recordSeasonMatch, seasonOpponent, simulateRestOfCup, startCup, startSeason, type QuickSim } from '../src/meta/competitions.ts';
import { applyResult, CUP_WAIT, MARKET_REFRESH_MS, newGame as freshGame, offeredOpponent, rankedScale, refreshMarketIfStale, type Save } from '../src/meta/game.ts';
import { HISTORY_CAP, lifetimeMatches } from '../src/meta/history.ts';
import { academyIntake, academyPotentialBonus, marketSize, prizeBonus, scoutMatchesFor, squadCap, totalXpForLevel, UNLOCKS, winTrainingBonus } from '../src/meta/levels.ts';
import { beginMatch, settleAbandoned } from '../src/meta/pending.ts';
import { maybeRollover, runRollover } from '../src/meta/progression.ts';
import { playerDivision } from '../src/meta/world.ts';

function newGame(seed: number, level = 10): Save {
  const s = freshGame(seed);
  s.xp = totalXpForLevel(level);
  return s;
}
const homeWins: QuickSim = () => ({ ga: 1, gb: 0 });
const marketIds = (s: Save) => s.market.map((p) => p.id).join();
const roundTrip = (s: Save): Save => JSON.parse(JSON.stringify(s));

describe('forfeits do not move the calendar', () => {
  test('ten forfeited cup ties leave the week alone and roll nothing over', () => {
    const s = newGame(1);
    for (let k = 0; k < 10; k++) {
      s.cupWait = 0;
      startCup(s);
      recordCupMatch(s, 0, 3, [], homeWins, true);
      simulateRestOfCup(s, homeWins);
      closeCup(s);
      expect(maybeRollover(s)).toBeNull();
    }
    expect(s.week).toBe(0);
    expect(s.year).toBe(1);
  });
  test('a ranked forfeit is recorded but no week passes', () => {
    const s = newGame(2);
    applyResult(s, s.ladder[0], s.ladder[0], 0, 3, true, [], undefined, true);
    expect(s.history.length).toBe(1);
    expect(s.week).toBe(0);
    applyResult(s, s.ladder[0], s.ladder[0], 1, 0, true, []);
    expect(s.week).toBe(1);
  });
});

describe('cups wait between editions', () => {
  test('a new cup needs CUP_WAIT ranked or league matches played since the last one started', () => {
    const s = newGame(3);
    expect(canStart(s, 'cup').ok).toBe(true);
    startCup(s);
    for (let r = 0; r < 3; r++) recordCupMatch(s, 2, 0, [], homeWins);
    closeCup(s);
    expect(cupWaitLeft(s)).toBe(CUP_WAIT);
    const blocked = canStart(s, 'cup');
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toBe(`Next cup after ${CUP_WAIT} more ranked or league matches.`);
    // Practice and forfeits don't count down.
    applyResult(s, null, { name: 'Reserve XI', short: 'RES' }, 3, 0, false, [], undefined, false, 'easy');
    applyResult(s, s.ladder[0], s.ladder[0], 0, 3, true, [], undefined, true);
    expect(cupWaitLeft(s)).toBe(CUP_WAIT);
    for (let k = 0; k < CUP_WAIT - 1; k++) applyResult(s, s.ladder[k], s.ladder[k], 1, 1, true, []);
    expect(canStart(s, 'cup').ok).toBe(false);
    startSeason(s);
    recordSeasonMatch(s, 1, 0, [], homeWins);
    expect(canStart(s, 'cup').ok).toBe(true);
    // The league itself never waits.
    expect(canStart(s, 'league').ok).toBe(true);
  });
  test('a forfeited cup tie costs Elo', () => {
    const s = newGame(4);
    startCup(s);
    const elo = s.club.elo;
    recordCupMatch(s, 0, 3, [], homeWins, true);
    expect(s.club.elo).toBeLessThan(elo);
  });
});

describe('league forfeits', () => {
  test('a fully forfeited season pays nothing, wins nothing and still relegates', () => {
    const s = newGame(5);
    s.division = 3;
    startSeason(s);
    const budget = s.budget;
    const xp = s.xp;
    let out;
    for (let d = 0; d < 7; d++) out = recordSeasonMatch(s, 0, 3, [], homeWins, true);
    expect(s.budget).toBe(budget);
    expect(s.xp).toBe(xp);
    expect(out!.money).toBe(0);
    expect(s.trophies!.length).toBe(0);
    expect(s.season!.finish).toBe(8);
    expect(playerDivision(s)).toBe(4);
  });
  test('a title with more than two forfeited matchdays wins no trophy and no promotion', () => {
    const s = newGame(6);
    startSeason(s);
    // Forfeit three, then win the rest 9-0 (the fake sim gives CPU clubs only 1-0s).
    for (let d = 0; d < 3; d++) recordSeasonMatch(s, 0, 3, [], () => ({ ga: 0, gb: 0 }), true);
    for (let d = 3; d < 7; d++) recordSeasonMatch(s, 9, 0, [], () => ({ ga: 0, gb: 0 }));
    expect(s.season!.forfeits).toBe(3);
    expect(s.trophies!.length).toBe(0);
    expect(playerDivision(s)).toBe(4);
  });
});

describe('ranked rewards follow the opponent', () => {
  test('beating a stronger club pays more than beating a weaker one; equal pays the table', () => {
    const s = newGame(7);
    const same = s.ladder.filter((c) => c.division === 4);
    const strong = { ...same[0], elo: s.club.elo + 200 };
    const weak = { ...same[1], elo: s.club.elo - 200 };
    const even = { ...same[2], elo: s.club.elo };
    expect(rankedScale(s, strong).xp).toBeGreaterThan(rankedScale(s, even).xp);
    expect(rankedScale(s, even).xp).toBe(1);
    expect(rankedScale(s, weak).xp).toBeLessThan(1);
    expect(rankedScale(s, s.ladder.find((c) => c.division === 1)!).money).toBeGreaterThan(2);
  });
  test('sandbagging: dropping Elo by forfeits buys weaker ranked opponents that pay less, and no easier league', () => {
    const honest = newGame(8);
    const tank = roundTrip(honest);
    const field = (x: Save) => pickEntrants(x, 'league').sort().join();
    const leagueBefore = field(tank);
    for (let k = 0; k < 9; k++) {
      const o = offeredOpponent(tank);
      applyResult(tank, o, o, 0, 3, true, [], undefined, true);
    }
    expect(tank.club.elo).toBeLessThan(honest.club.elo - 150);
    expect(field(tank)).toBe(leagueBefore); // the same clubs: your division, not your Elo
    // Ten wins afterwards earn less than ten honest wins from the start.
    const win10 = (s: Save) => {
      const xp0 = s.xp!;
      const money0 = s.budget;
      for (let k = 0; k < 10; k++) {
        const o = offeredOpponent(s);
        applyResult(s, o, o, 2, 1, true, []);
      }
      return { xp: s.xp! - xp0, money: s.budget - money0 };
    };
    const a = win10(honest);
    const b = win10(tank);
    expect(b.xp).toBeLessThan(a.xp);
    expect(b.money).toBeLessThan(a.money);
  });
});

describe('the ranked opponent is fixed once offered', () => {
  test('the same club across calls and reloads; a new one after the match', () => {
    const s = newGame(9);
    const first = offeredOpponent(s);
    for (let k = 0; k < 6; k++) {
      const again = roundTrip(s);
      expect(offeredOpponent(again).id).toBe(first.id);
    }
    applyResult(s, first, first, 1, 0, true, []);
    expect(s.nextOpp).toBeNull();
    expect(offeredOpponent(s).id).not.toBe(first.id); // never the club you just played
  });
});

describe('abandoned matches', () => {
  test('a ranked match left mid-way counts as a 0–3 forfeit on the next boot, with a plain message', () => {
    const s = newGame(10);
    const opp = offeredOpponent(s);
    beginMatch(s, { kind: 'ranked', opponentId: opp.id, opponent: opp.name, label: 'Ranked' });
    const loaded = roundTrip(s); // the tab closed: this is what was saved at kick-off
    const budget = loaded.budget;
    const out = settleAbandoned(loaded)!;
    expect(loaded.history.length).toBe(1);
    expect(loaded.history[0]).toMatchObject({ goalsFor: 0, goalsAgainst: 3, forfeited: true });
    expect(out.eloDelta).toBeLessThan(0);
    expect(loaded.budget).toBe(budget);
    expect(loaded.pending).toBeNull();
    expect(out.message).toContain(opp.name);
    expect(out.message).toContain('0–3 forfeit');
    // Settled once only.
    expect(settleAbandoned(loaded)).toBeNull();
    expect(loaded.history.length).toBe(1);
  });
  test('a finished match clears the mark', () => {
    const s = newGame(11);
    const opp = offeredOpponent(s);
    beginMatch(s, { kind: 'ranked', opponentId: opp.id, opponent: opp.name, label: 'Ranked' });
    applyResult(s, opp, opp, 2, 2, true, []);
    expect(s.pending).toBeNull();
    expect(settleAbandoned(s)).toBeNull();
  });
  test('cup and league matches are settled in their competition; friendlies record nothing', () => {
    const s = newGame(12);
    startCup(s);
    const opp = cupOpponent(s, s.cup!)!;
    beginMatch(s, { kind: 'cup', opponent: opp.name, label: 'Cup quarter-final' });
    expect(settleAbandoned(s)).not.toBeNull();
    expect(s.cup!.rounds[0].some((t) => t.winner === opp.id)).toBe(true);
    startSeason(s);
    const lo = seasonOpponent(s, s.season!)!;
    beginMatch(s, { kind: 'league', opponent: lo.name, label: 'League matchday 1' });
    settleAbandoned(s);
    expect(s.season!.matchday).toBe(1);
    expect(s.season!.forfeits).toBe(1);
    const n = s.history.length;
    beginMatch(s, { kind: 'friendly', opponent: 'Reserve XI', label: 'Friendly' });
    expect(settleAbandoned(s)).toBeNull();
    expect(s.history.length).toBe(n);
    expect(s.pending).toBeNull();
  });
});

describe('the transfer market', () => {
  test('refreshes after cup, league and practice matches, not only ranked', () => {
    const s = newGame(13);
    let ids = marketIds(s);
    startCup(s);
    recordCupMatch(s, 1, 0, [], homeWins);
    expect(marketIds(s)).not.toBe(ids);
    ids = marketIds(s);
    applyResult(s, null, { name: 'Reserve XI', short: 'RES' }, 1, 0, false, [], undefined, false, 'easy');
    expect(marketIds(s)).not.toBe(ids);
  });
  test('and on the clock: six hours after it was last refreshed', () => {
    const s = newGame(14);
    const t = 1_700_000_000_000;
    expect(refreshMarketIfStale(s, t)).toBe(false); // starts the clock
    const ids = marketIds(s);
    expect(refreshMarketIfStale(s, t + MARKET_REFRESH_MS - 1)).toBe(false);
    expect(marketIds(s)).toBe(ids);
    expect(refreshMarketIfStale(s, t + MARKET_REFRESH_MS)).toBe(true);
    expect(marketIds(s)).not.toBe(ids);
    expect(refreshMarketIfStale(s, t)).toBe(false); // a clock moved back only restarts it
  });
});

describe('history', () => {
  test('keeps the latest matches, drops the rest, and the records and totals survive', () => {
    const s = newGame(15);
    applyResult(s, s.ladder[0], s.ladder[0], 7, 0, true, []);
    for (let k = 0; k < HISTORY_CAP + 40; k++) applyResult(s, s.ladder[k % 30], s.ladder[k % 30], k % 3, 1, true, []);
    expect(s.history.length).toBe(HISTORY_CAP);
    expect(s.historyBase).toBe(41);
    expect(lifetimeMatches(s)).toBe(HISTORY_CAP + 41);
    expect(s.records!.played).toBe(HISTORY_CAP + 41);
    expect(s.records!.biggestWin!.value).toBe(7);
    expect(s.records!.biggestWin!.text).toContain('7–0');
    expect(s.eloHistory.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(s).length).toBeLessThan(160_000);
  });
  test('practice does not count toward the records', () => {
    const s = newGame(16);
    applyResult(s, null, { name: 'Reserve XI', short: 'RES' }, 9, 0, false, [], undefined, false, 'easy');
    expect(s.records!.played).toBe(0);
    expect(s.records!.biggestWin).toBeUndefined();
  });
  test('a season review still finds this year\'s trophies after old matches dropped off', () => {
    const s = newGame(17);
    s.historyBase = 500;
    startCup(s);
    for (let r = 0; r < 3; r++) recordCupMatch(s, 2, 0, [], homeWins);
    expect(s.trophies![0].atMatch).toBe(503);
    const review = runRollover(s);
    expect(review.record.trophies).toEqual(['Cup 1']);
    expect(s.seasons![0].notes).toEqual(['Cup 1: winners']);
  });
});

describe('late perks', () => {
  test('no gap past level 22 is longer than five levels, and each perk does what it says', () => {
    const levels = [...new Set(UNLOCKS.map((u) => u.level))].filter((l) => l >= 22);
    for (let k = 1; k < levels.length; k++) expect(levels[k] - levels[k - 1]).toBeLessThanOrEqual(5);
    const at = (level: number) => newGame(30, level);
    expect(squadCap(at(94))).toBe(27);
    expect(squadCap(at(95))).toBe(28);
    expect(marketSize(at(90))).toBe(16);
    expect(winTrainingBonus(at(84))).toBe(1);
    expect(winTrainingBonus(at(85))).toBe(2);
    expect(scoutMatchesFor(at(54), 6)).toBe(5);
    expect(scoutMatchesFor(at(55), 6)).toBe(3);
    expect(academyIntake(at(45))).toEqual([3, 4]);
    expect(academyPotentialBonus(at(70))).toBe(3);
    expect(prizeBonus(at(59))).toBe(1);
    const s = at(60);
    startSeason(s);
    const before = s.budget;
    for (let d = 0; d < 7; d++) recordSeasonMatch(s, 3, 0, [], homeWins);
    expect(s.budget - before).toBe(495_000); // ƒ450k +10%
  });
  test('a rollover at level 45 brings three or four prospects', () => {
    const s = newGame(31, 45);
    s.squad = s.squad.slice(0, 18);
    const review = runRollover(s);
    expect(review.intake.length).toBeGreaterThanOrEqual(3);
  });
});
