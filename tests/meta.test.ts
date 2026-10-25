import { describe, expect, test } from 'bun:test';
import { autoLineup } from '../src/meta/club.ts';
import { eloDelta, expectedScore, goalDiffMultiplier } from '../src/meta/elo.ts';
import { applyResult, askingPrice, buyPlayer, ensureElevenASide, ladderTable, MAX_SQUAD, MIN_SQUAD, newGame, salePrice, sellPlayer, setFormation, setLineupSlot, train } from '../src/meta/game.ts';
import { clubName } from '../src/meta/names.ts';
import { overall } from '../src/meta/player.ts';
import { makeRng } from '../src/sim/rng.ts';

describe('elo', () => {
  test('equal ratings expect 0.5', () => expect(expectedScore(1200, 1200)).toBeCloseTo(0.5));
  test('zero-sum between equal-K sides', () => {
    expect(eloDelta(1100, 1000, 2, 1, 20) + eloDelta(1000, 1100, 1, 2, 20)).toBe(0);
  });
  test('upset win pays more than expected win', () => {
    expect(eloDelta(1000, 1300, 1, 0, 20)).toBeGreaterThan(eloDelta(1300, 1000, 1, 0, 20));
  });
  test('goal difference multiplier', () => {
    expect(goalDiffMultiplier(1)).toBe(1);
    expect(goalDiffMultiplier(2)).toBe(1.5);
    expect(goalDiffMultiplier(4)).toBeCloseTo(15 / 8);
  });
});

describe('names', () => {
  test('club names are deterministic per seed', () => {
    expect(clubName(makeRng(5))).toEqual(clubName(makeRng(5)));
  });
});

describe('club loop', () => {
  test('new game has a full lineup and a market', () => {
    const s = newGame(123);
    expect(s.lineup.filter(Boolean).length).toBe(11);
    expect(new Set(s.lineup).size).toBe(11);
    expect(s.squad.length).toBe(18);
    expect(s.market.length).toBe(10);
    expect(s.ladder.length).toBe(31); // four divisions of eight, with you (src/meta/world.ts)
  });

  test('buying and selling move money and players', () => {
    const s = newGame(321);
    s.budget = 50_000_000;
    const target = s.market[0];
    const before = s.budget;
    expect(buyPlayer(s, target.id).ok).toBe(true);
    expect(s.budget).toBe(before - askingPrice(target));
    expect(s.squad.some((p) => p.id === target.id)).toBe(true);
    const sold = s.squad[0];
    const mid = s.budget;
    expect(sellPlayer(s, sold.id).ok).toBe(true);
    expect(s.budget).toBe(mid + salePrice(sold));
  });

  test('squad cap is enforced', () => {
    const s = newGame(9);
    s.budget = 1e12;
    while (s.squad.length < MAX_SQUAD) s.squad.push({ ...s.squad[0], id: `${s.squad.length}x` });
    expect(buyPlayer(s, s.market[0].id).ok).toBe(false);
  });

  test('training spends a session and never lowers attributes', () => {
    const s = newGame(77);
    const p = s.squad.find((x) => x.age < 23) ?? s.squad[0];
    const sessions = s.trainingPoints;
    const before = p.attrs.passing;
    train(s, p.id, 'passing');
    expect(s.trainingPoints).toBe(sessions - 1);
    expect(p.attrs.passing).toBeGreaterThanOrEqual(before);
  });

  test('lineup swap keeps players unique', () => {
    const s = newGame(5);
    const a = s.lineup[1];
    const b = s.lineup[3];
    setLineupSlot(s, 1, b);
    expect(s.lineup[1]).toBe(b);
    expect(s.lineup[3]).toBe(a);
    expect(new Set(s.lineup).size).toBe(11);
  });

  test('ranked result updates elo, record and ladder', () => {
    const s = newGame(11);
    const opp = s.ladder[0];
    const oppBefore = opp.elo;
    const r = applyResult(s, opp, opp, 3, 0, true, []);
    expect(r.eloDelta).toBeGreaterThan(0);
    expect(s.club.elo).toBe(1000 + r.eloDelta);
    expect(opp.elo).toBeLessThan(oppBefore);
    expect(s.club.won).toBe(1);
    expect(ladderTable(s).some((row) => row.you)).toBe(true);
  });

  test('a six-a-side save is brought up to eleven-a-side on load', () => {
    const s = newGame(44);
    s.squad = s.squad.slice(0, 10);
    s.lineup = s.lineup.slice(0, 6);
    delete s.formation;
    ensureElevenASide(s);
    expect(s.squad.length).toBe(18);
    expect(s.formation).toBe('4-4-2');
    expect(new Set(s.lineup).size).toBe(11);
    expect(s.lineup.every((id) => s.squad.some((p) => p.id === id))).toBe(true);
    expect(new Set(s.squad.map((p) => p.number)).size).toBe(18);
    expect(s.squad.filter((p) => p.role === 'GK').length).toBeGreaterThanOrEqual(2);
    // Safe to call again: nothing changes.
    const before = JSON.stringify(s.squad);
    ensureElevenASide(s);
    expect(JSON.stringify(s.squad)).toBe(before);
    expect(MIN_SQUAD).toBe(14);
  });

  test('changing formation re-picks the XI for the new slots', () => {
    const s = newGame(45);
    setFormation(s, '4-3-3');
    expect(s.formation).toBe('4-3-3');
    expect(new Set(s.lineup).size).toBe(11);
  });

  test('auto lineup prefers a real keeper in goal', () => {
    const s = newGame(31);
    const gk = s.squad.find((p) => p.id === autoLineup(s.squad)[0])!;
    expect(gk.role).toBe('GK');
    expect(overall(gk)).toBeGreaterThan(30);
  });
});

describe('forfeits', () => {
  test('a ranked forfeit costs Elo but pays no money, sessions or development', () => {
    const s = newGame(41);
    const opp = s.ladder[0];
    const budget = s.budget;
    const sessions = s.trainingPoints;
    const attrs = JSON.stringify(s.squad.map((p) => p.attrs));
    const r = applyResult(s, opp, opp, 0, 3, true, [], undefined, true);
    expect(r.eloDelta).toBeLessThan(0);
    expect(s.budget).toBe(budget);
    expect(s.trainingPoints).toBe(sessions);
    expect(r.money).toBe(0);
    expect(JSON.stringify(s.squad.map((p) => p.attrs))).toBe(attrs);
  });
});
