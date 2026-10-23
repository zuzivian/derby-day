import { describe, expect, test } from 'bun:test';
import {
  CUP_PRIZES,
  COMP_SIZE,
  SEASON_PRIZES,
  closeCup,
  cupOpponent,
  ensureCompetitionFields,
  isOut,
  ordinal,
  penaltyShootout,
  pickEntrants,
  realQuickSim,
  recordCupMatch,
  recordSeasonMatch,
  roundRobin,
  seasonTable,
  simulateRestOfCup,
  startCup,
  startSeason,
  yourFixture,
  yourTie,
  type QuickSim,
} from '../src/meta/competitions.ts';
import { isSave, newGame, type Save } from '../src/meta/game.ts';
import { makeRng } from '../src/sim/rng.ts';

/** Fast stand-in for the headless sim: the higher-Elo club wins 2–1, every fourth match is 1–1. */
const fakeSim: QuickSim = (_s, a, b, seed) => {
  if (seed % 4 === 0) return { ga: 1, gb: 1 };
  return a.elo >= b.elo ? { ga: 2, gb: 1 } : { ga: 1, gb: 2 };
};

const ladderSnapshot = (s: Save) => JSON.stringify(s.ladder.map((c) => [c.id, c.elo, c.played]));

describe('entrants', () => {
  test('you plus seven ladder clubs, unique, best Elo first', () => {
    const s = newGame(101);
    const ids = pickEntrants(s);
    expect(ids.length).toBe(COMP_SIZE);
    expect(new Set(ids).size).toBe(COMP_SIZE);
    expect(ids).toContain(s.club.id);
    const elos = ids.map((id) => (id === s.club.id ? s.club.elo : s.ladder.find((c) => c.id === id)!.elo));
    for (let k = 1; k < elos.length; k++) expect(elos[k - 1]).toBeGreaterThanOrEqual(elos[k]);
  });
});

describe('cup', () => {
  test('quarter-finals pair seed 1 with seed 8 and use every entrant once', () => {
    const s = newGame(5);
    const cup = startCup(s);
    expect(cup.rounds[0].length).toBe(4);
    expect(cup.rounds[0][0]).toEqual({ a: cup.entrants[0], b: cup.entrants[7] });
    const used = cup.rounds[0].flatMap((t) => [t.a, t.b]);
    expect(new Set(used).size).toBe(8);
    expect(yourTie(s, cup)).not.toBeNull();
    expect(cupOpponent(s, cup)).not.toBeNull();
  });

  test('winning every round pays all the prizes, records the trophy and leaves Elo alone', () => {
    const s = newGame(6);
    const elo = s.club.elo;
    const played = s.club.played;
    const ladder = ladderSnapshot(s);
    const budget = s.budget;
    startCup(s);
    const notes: string[] = [];
    for (let r = 0; r < 3; r++) notes.push(recordCupMatch(s, 3, 0, [], fakeSim).note);
    expect(s.cup!.done).toBe(true);
    expect(s.cup!.winner).toBe(s.club.id);
    expect(s.trophies!.length).toBe(1);
    expect(s.trophies![0].kind).toBe('cup');
    expect(s.budget - budget).toBe(CUP_PRIZES.reduce((a, b) => a + b, 0));
    expect(s.club.elo).toBe(elo);
    expect(s.club.played).toBe(played);
    expect(ladderSnapshot(s)).toBe(ladder);
    expect(s.history.at(-1)!.competition).toBe('Cup final');
    expect(notes[2]).toContain('Cup winners');
  });

  test('a drawn tie goes to penalties and always produces a winner, the same one each time', () => {
    const run = () => {
      const s = newGame(7);
      startCup(s);
      recordCupMatch(s, 1, 1, [], fakeSim);
      const t = s.cup!.rounds[0].find((x) => x.a === s.club.id || x.b === s.club.id)!;
      return { pens: t.pens, winner: t.winner };
    };
    const a = run();
    expect(a.pens).toBeDefined();
    expect(a.pens![0]).not.toBe(a.pens![1]);
    expect(a.winner).toBeDefined();
    expect(run()).toEqual(a);
  });

  test('every CPU tie in a round is settled, draws included', () => {
    const s = newGame(8);
    startCup(s);
    recordCupMatch(s, 2, 0, [], fakeSim);
    for (const t of s.cup!.rounds[0]) expect(t.winner).toBeDefined();
    expect(s.cup!.round).toBe(1);
    expect(s.cup!.rounds[1].length).toBe(2);
  });

  test('knocked out: the rest of the cup can be simulated to a winner who is not you', () => {
    const s = newGame(9);
    startCup(s);
    const out = recordCupMatch(s, 0, 2, [], fakeSim);
    expect(out.note).toContain('Out in the quarter-final');
    expect(isOut(s, s.cup!)).toBe(true);
    expect(yourTie(s, s.cup!)).toBeNull();
    simulateRestOfCup(s, fakeSim);
    expect(s.cup!.done).toBe(true);
    expect(s.cup!.winner).not.toBe(s.club.id);
    expect(s.trophies!.length).toBe(0);
    closeCup(s);
    expect(s.cup).toBeNull();
  });

  test('penalties favour better takers and never end level', () => {
    const r = makeRng(1);
    const good = { takers: [0.9, 0.9, 0.85, 0.85, 0.8], keeper: 0.85 };
    const poor = { takers: [0.35, 0.35, 0.3, 0.3, 0.3], keeper: 0.35 };
    let goodWins = 0;
    for (let k = 0; k < 400; k++) {
      const [a, b] = penaltyShootout(r, good, poor);
      expect(a).not.toBe(b);
      if (a > b) goodWins++;
    }
    expect(goodWins).toBeGreaterThan(280);
  });

  test('a real quick-sim tie returns a finite scoreline', () => {
    const s = newGame(10);
    const [a, b] = s.ladder;
    const r = realQuickSim(s, a, b, 123);
    expect(Number.isInteger(r.ga) && Number.isInteger(r.gb)).toBe(true);
    expect(r.ga + r.gb).toBeLessThan(15);
  });
});

describe('season', () => {
  test('single round robin: 7 matchdays, everyone meets everyone once, one match a day', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const days = roundRobin(ids);
    expect(days.length).toBe(7);
    const pairs = new Set<string>();
    const homes = new Map<string, number>();
    for (const day of days) {
      expect(day.length).toBe(4);
      const today = day.flatMap((f) => [f.home, f.away]);
      expect(new Set(today).size).toBe(8);
      for (const f of day) {
        pairs.add([f.home, f.away].sort().join('-'));
        homes.set(f.home, (homes.get(f.home) ?? 0) + 1);
      }
    }
    expect(pairs.size).toBe(28);
    for (const id of ids) expect(homes.get(id) ?? 0).toBeGreaterThanOrEqual(3);
  });

  test('a full season fills the table, pays by position and leaves Elo alone', () => {
    const s = newGame(12);
    const elo = s.club.elo;
    const ladder = ladderSnapshot(s);
    startSeason(s);
    let budget = s.budget;
    for (let d = 0; d < 7; d++) {
      expect(yourFixture(s, s.season!)).not.toBeNull();
      const before = s.budget;
      const o = recordSeasonMatch(s, 2, 0, [], fakeSim);
      if (d < 6) expect(s.budget).toBe(before);
      budget = s.budget - before;
      expect(o.note.length).toBeGreaterThan(5);
    }
    const season = s.season!;
    expect(season.done).toBe(true);
    const table = seasonTable(s, season);
    expect(table.every((r) => r.played === 7)).toBe(true);
    for (const r of table) expect(r.points).toBe(r.won * 3 + r.drawn);
    expect(table.reduce((t, r) => t + r.gf, 0)).toBe(table.reduce((t, r) => t + r.ga, 0));
    expect(table[0].you).toBe(true); // won every match 2–0
    expect(season.finish).toBe(1);
    expect(budget).toBe(SEASON_PRIZES[0]);
    expect(s.trophies!.some((t) => t.kind === 'season')).toBe(true);
    expect(s.club.elo).toBe(elo);
    expect(ladderSnapshot(s)).toBe(ladder);
  });

  test('table sorts by points, then goal difference, then goals scored', () => {
    const s = newGame(13);
    const season = startSeason(s);
    const [x, y, z] = season.entrants;
    // Hand-written results: x and y both on 3 points, y with the better goal difference.
    season.matchdays = [[
      { home: x, away: z, hg: 1, ag: 0 },
      { home: y, away: season.entrants[3], hg: 3, ag: 0 },
    ]];
    const t = seasonTable(s, season);
    expect(t[0].id).toBe(y);
    expect(t[1].id).toBe(x);
  });
});

describe('saves', () => {
  test('old saves without competition fields still load and get defaults', () => {
    const s = newGame(14) as Save & Record<string, unknown>;
    const old = JSON.parse(JSON.stringify(s));
    delete old.cup;
    delete old.season;
    delete old.trophies;
    expect(isSave(old)).toBe(true);
    ensureCompetitionFields(old);
    expect(old.cup).toBeNull();
    expect(old.trophies).toEqual([]);
    expect(isSave({ ...old, trophies: 'nope' })).toBe(false);
  });

  test('a save with a cup in progress survives JSON and carries on', () => {
    const s = newGame(15);
    startCup(s);
    recordCupMatch(s, 1, 0, [], fakeSim);
    const back = JSON.parse(JSON.stringify(s)) as Save;
    expect(isSave(back)).toBe(true);
    expect(yourTie(back, back.cup!)).not.toBeNull();
    recordCupMatch(back, 1, 0, [], fakeSim);
    expect(back.cup!.round).toBe(2);
  });

  test('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
  });
});
