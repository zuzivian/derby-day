import { describe, expect, test } from 'bun:test';
import { ladderSquad } from '../src/meta/club.ts';
import { applyResult, isSave, MAX_SQUAD, MIN_SQUAD, newGame as freshGame, type Save } from '../src/meta/game.ts';
import { totalXpForLevel } from '../src/meta/levels.ts';
import { generatePlayer, overall, type Player } from '../src/meta/player.ts';
import {
  agePlayer,
  ensureProgressionFields,
  generateProspect,
  maybeRollover,
  potentialText,
  retireChance,
  rolloverDue,
  runRollover,
  scoutedPotential,
  SCOUT_MATCHES,
  SEASON_WEEKS,
  signProspect,
  starsFor,
  weekOfYear,
} from '../src/meta/progression.ts';
import { makeRng } from '../src/sim/rng.ts';

/** A new club at level 10, where the season calendar is unlocked (level 15's bigger squad is not). */
function newGame(seed: number): Save {
  const s = freshGame(seed);
  s.xp = totalXpForLevel(10);
  return s;
}

/** Mean overall change over many seeded players of a given starting age and quality. */
function meanChange(age: number, attr?: 'pace' | 'passing' | 'stamina', n = 300): number {
  const r = makeRng(age * 1009 + 7);
  let total = 0;
  for (let k = 0; k < n; k++) {
    const p = generatePlayer(r, { role: 'MID', quality: 60, age });
    p.potential = 72;
    const before = attr ? p.attrs[attr] : overall(p);
    agePlayer(r, p);
    total += (attr ? p.attrs[attr] : overall(p)) - before;
  }
  return total / n;
}

/** Everything deterministic about a save's squad, ignoring ids from the generator's module-level counter. */
const fingerprint = (s: Save) => JSON.stringify([s.squad.map((p) => [p.first, p.last, p.age, p.role, p.attrs, p.potential]), s.offers?.map((p) => [p.first, p.last, p.attrs, p.potential]), s.ladder.map((c) => [c.elo, c.era])]);

/** Play `n` counted matches (ranked) on a save without rolling over. */
function playWeeks(s: Save, n: number): void {
  for (let k = 0; k < n; k++) applyResult(s, s.ladder[k % s.ladder.length], { name: 'X', short: 'X' }, k % 3, 1, true, []);
}

describe('ageing curve', () => {
  test('young players with headroom grow', () => {
    expect(meanChange(18)).toBeGreaterThan(2);
    expect(meanChange(21)).toBeGreaterThan(1);
  });
  test('24-27 grow a little', () => {
    const m = meanChange(25);
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(2);
  });
  test('28-30 plateau', () => {
    expect(Math.abs(meanChange(28))).toBeLessThan(0.6);
    expect(Math.abs(meanChange(29))).toBeLessThan(0.6);
  });
  test('31+ decline, and get worse with age', () => {
    expect(meanChange(31)).toBeLessThan(-0.5);
    expect(meanChange(35)).toBeLessThan(meanChange(31));
  });
  test('pace and stamina decline before passing', () => {
    expect(meanChange(32, 'pace')).toBeLessThan(meanChange(32, 'passing'));
    expect(meanChange(32, 'stamina')).toBeLessThan(meanChange(32, 'passing'));
  });
  test('ageing adds a year, keeps potential at or above overall and never shows growth past 30', () => {
    const r = makeRng(3);
    for (let k = 0; k < 200; k++) {
      const p = generatePlayer(r, { quality: 55, age: 17 + (k % 22) });
      const age = p.age;
      const before = { ...p.attrs };
      agePlayer(r, p);
      expect(p.age).toBe(age + 1);
      expect(p.potential).toBeGreaterThanOrEqual(overall(p));
      expect(p.potential).toBeLessThanOrEqual(95);
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        expect(p.attrs[key]).toBeGreaterThanOrEqual(1);
        expect(p.attrs[key]).toBeLessThanOrEqual(99);
        if (p.age >= 31) expect(p.attrs[key]).toBeLessThanOrEqual(before[key]);
        if (p.age <= 23) expect(p.attrs[key]).toBeGreaterThanOrEqual(before[key]);
      }
    }
  });
  test('young potential can surprise either way', () => {
    const r = makeRng(99);
    let up = 0;
    let down = 0;
    for (let k = 0; k < 400; k++) {
      const p = generatePlayer(r, { quality: 55, age: 18 });
      p.potential = 75;
      agePlayer(r, p);
      // Compare against the 75 we started with, ignoring the floor at overall.
      if (p.potential >= 80) up++;
      if (p.potential <= 72) down++;
    }
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(0);
  });
});

describe('retirements', () => {
  test('chance is zero below 34 and grows after', () => {
    expect(retireChance(33)).toBe(0);
    expect(retireChance(34)).toBeGreaterThan(0);
    for (let a = 35; a < 40; a++) expect(retireChance(a)).toBeGreaterThanOrEqual(retireChance(a - 1));
    expect(retireChance(40)).toBe(1);
  });

  test('only 34+ retire, they leave the squad and the news says so', () => {
    let retiredTotal = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const s = newGame(seed);
      // A mixed-age squad: several veterans of 33..38.
      s.squad.forEach((p, i) => (p.age = 20 + ((i * 7) % 19)));
      const before = new Map(s.squad.map((p) => [p.id, p]));
      const review = runRollover(s);
      for (const e of review.retired) {
        expect(e.age).toBeGreaterThanOrEqual(34);
        expect(s.news.some((n) => n.includes(e.name) && n.includes('retires'))).toBe(true);
      }
      for (const [id, p] of before) {
        if (!s.squad.some((x) => x.id === id)) expect(p.age).toBeGreaterThanOrEqual(34);
      }
      retiredTotal += review.retired.length;
    }
    expect(retiredTotal).toBeGreaterThan(0);
  });

  test('a squad of veterans is never retired below the minimum or without a keeper', () => {
    const s = newGame(8);
    for (const p of s.squad) p.age = 41; // everyone wants out
    const keepers = s.squad.filter((p) => p.role === 'GK').length;
    expect(keepers).toBeGreaterThan(0);
    runRollover(s);
    const intake = s.squad.filter((p) => p.age < 18).length;
    expect(s.squad.length - intake).toBeGreaterThanOrEqual(MIN_SQUAD);
    expect(s.squad.some((p) => p.role === 'GK')).toBe(true);
    expect(s.lineup.every((id) => s.squad.some((p) => p.id === id))).toBe(true);
    expect(new Set(s.lineup).size).toBe(11);
  });
});

describe('youth intake', () => {
  test('prospects are 16-17, low overall, and potential varies with some gems', () => {
    const r = makeRng(11);
    const ps = Array.from({ length: 300 }, () => generateProspect(r, 1));
    for (const p of ps) {
      expect([16, 17]).toContain(p.age);
      expect(overall(p)).toBeLessThan(56);
      expect(p.potential).toBeGreaterThan(overall(p));
      expect(p.scout).toBe(SCOUT_MATCHES);
    }
    const pots = ps.map((p) => p.potential);
    expect(Math.max(...pots)).toBeGreaterThanOrEqual(80);
    expect(Math.min(...pots)).toBeLessThan(68);
  });

  test('2-3 prospects join when there is room', () => {
    const s = newGame(21);
    s.squad = s.squad.slice(0, 8);
    s.lineup = s.lineup.map((id) => (s.squad.some((p) => p.id === id) ? id : s.squad[0].id));
    for (const p of s.squad) p.age = 25;
    const review = runRollover(s);
    expect(review.intake.length).toBeGreaterThanOrEqual(2);
    expect(review.intake.length).toBeLessThanOrEqual(3);
    expect(review.intake.every((i) => i.joined)).toBe(true);
    expect(s.squad.length).toBe(8 + review.intake.length);
    expect(s.offers).toEqual([]);
  });

  test('never exceeds MAX_SQUAD: the overflow is offered instead', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = newGame(seed);
      while (s.squad.length < MAX_SQUAD) s.squad.push(generatePlayer(makeRng(seed + s.squad.length), { quality: 50, age: 27 }));
      for (const p of s.squad) p.age = 25; // nobody retires
      const review = runRollover(s);
      expect(s.squad.length).toBeLessThanOrEqual(MAX_SQUAD);
      expect(s.squad.length).toBe(MAX_SQUAD);
      expect(review.intake.every((i) => !i.joined)).toBe(true);
      expect(s.offers!.length).toBe(review.intake.length);
      expect(s.offers!.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('retirements make room for intake', () => {
    const s = newGame(5);
    while (s.squad.length < MAX_SQUAD) s.squad.push(generatePlayer(makeRng(s.squad.length), { quality: 50, age: 27 }));
    for (const p of s.squad) p.age = 25;
    for (const p of s.squad.slice(0, 5)) p.age = 41;
    s.squad.filter((p) => p.age === 41).forEach((p) => (p.role = 'MID')); // keep the keepers out of it
    const review = runRollover(s);
    expect(review.retired.length).toBe(5);
    expect(review.intake.filter((i) => i.joined).length).toBe(Math.min(review.intake.length, 5));
    expect(s.squad.length).toBeLessThanOrEqual(MAX_SQUAD);
  });

  test('signing an offer needs room or a release, and a release is free', () => {
    const s = newGame(9);
    while (s.squad.length < MAX_SQUAD) s.squad.push(generatePlayer(makeRng(s.squad.length + 40), { quality: 50, age: 27 }));
    for (const p of s.squad) p.age = 25;
    runRollover(s);
    const offer = s.offers![0];
    const budget = s.budget;
    expect(signProspect(s, offer.id).ok).toBe(false);
    expect(s.squad.length).toBe(MAX_SQUAD);
    const out = s.squad.find((p) => !s.lineup.includes(p.id))!;
    const r = signProspect(s, offer.id, out.id);
    expect(r.ok).toBe(true);
    expect(s.squad.length).toBe(MAX_SQUAD);
    expect(s.squad.some((p) => p.id === offer.id)).toBe(true);
    expect(s.squad.some((p) => p.id === out.id)).toBe(false);
    expect(s.offers!.some((p) => p.id === offer.id)).toBe(false);
    expect(s.budget).toBe(budget);
    expect(new Set(s.squad.map((p) => p.number)).size).toBe(s.squad.length);
  });

  test('unsigned offers expire at the next rollover', () => {
    const s = newGame(10);
    while (s.squad.length < MAX_SQUAD) s.squad.push(generatePlayer(makeRng(s.squad.length + 80), { quality: 50, age: 27 }));
    for (const p of s.squad) p.age = 25;
    runRollover(s);
    const first = s.offers!.length;
    for (const p of s.squad) p.age = 25;
    const review = runRollover(s);
    expect(review.expiredOffers).toBe(first);
  });
});

describe('scouting fog', () => {
  test('a fresh prospect shows a range containing the truth; it narrows with matches and ends exact', () => {
    const r = makeRng(4);
    for (let k = 0; k < 50; k++) {
      const p = generateProspect(r, 1);
      let width = Infinity;
      for (let left = SCOUT_MATCHES; left > 0; left--) {
        p.scout = left;
        const v = scoutedPotential(p);
        expect(v.exact).toBe(false);
        expect(v.lo).toBeLessThanOrEqual(p.potential);
        expect(v.hi).toBeGreaterThanOrEqual(p.potential);
        expect(v.hi - v.lo).toBeLessThanOrEqual(width);
        width = v.hi - v.lo;
        expect(v.stars).toBeGreaterThanOrEqual(1);
        expect(v.stars).toBeLessThanOrEqual(5);
      }
      p.scout = 0;
      expect(scoutedPotential(p).exact).toBe(true);
      expect(potentialText(p)).toBe(String(p.potential));
    }
  });
  test('range text and stars are deterministic per player', () => {
    const p = generateProspect(makeRng(2), 1);
    expect(potentialText(p)).toBe(potentialText({ ...p }));
    expect(potentialText(p)).toMatch(/^\d+–\d+$/);
    expect(starsFor(45)).toBe(1);
    expect(starsFor(85)).toBe(5);
  });
  test('playing matches lifts the fog', () => {
    const s = newGame(31);
    const p = generateProspect(makeRng(1), 1);
    s.squad.push(p);
    s.lineup[1] = p.id;
    for (let k = 0; k < SCOUT_MATCHES; k++) applyResult(s, null, { name: 'X', short: 'X' }, 1, 0, false, []);
    expect(p.scout).toBe(0);
    expect(scoutedPotential(p).exact).toBe(true);
  });
});

describe('calendar', () => {
  test('a week passes after every ranked or competition match, not after a friendly', () => {
    const s = newGame(50);
    expect(s.week).toBe(0);
    applyResult(s, s.ladder[0], { name: 'A', short: 'A' }, 1, 0, true, []);
    expect(s.week).toBe(1);
    applyResult(s, null, { name: 'A', short: 'A' }, 1, 0, false, [], 'Cup final');
    expect(s.week).toBe(2);
    applyResult(s, null, { name: 'A', short: 'A' }, 1, 0, false, []);
    expect(s.week).toBe(2);
    expect(s.history.map((m) => m.week)).toEqual([1, 2, undefined]);
  });

  test('rollover becomes due on week 10 and bumps the year once', () => {
    const s = newGame(51);
    playWeeks(s, SEASON_WEEKS - 1);
    expect(rolloverDue(s)).toBe(false);
    expect(maybeRollover(s)).toBeNull();
    expect(weekOfYear(s)).toBe(SEASON_WEEKS - 1);
    playWeeks(s, 1);
    expect(rolloverDue(s)).toBe(true);
    const review = maybeRollover(s)!;
    expect(review.year).toBe(1);
    expect(s.year).toBe(2);
    expect(s.review).toBe(review);
    expect(review.record.played).toBe(SEASON_WEEKS);
    expect(review.record.won + review.record.drawn + review.record.lost).toBe(SEASON_WEEKS);
    expect(maybeRollover(s)).toBeNull();
    expect(weekOfYear(s)).toBe(0);
  });

  test('review lists at most 5 changes with consistent before and after, biggest first', () => {
    const s = newGame(52);
    playWeeks(s, SEASON_WEEKS);
    const before = s.squad.length;
    const review = maybeRollover(s)!;
    expect(review.changes.length).toBeLessThanOrEqual(5);
    for (const c of review.changes) expect(c.after).not.toBe(c.before);
    const swings = review.changes.map((c) => Math.abs(c.after - c.before));
    expect(swings).toEqual([...swings].sort((a, b) => b - a));
    expect(review.improved + review.declined + review.steady + review.retired.length).toBe(before);
  });
});

describe('determinism', () => {
  test('the same seed and history roll over identically', () => {
    const a = newGame(77);
    const b = newGame(77);
    playWeeks(a, SEASON_WEEKS);
    playWeeks(b, SEASON_WEEKS);
    const ra = maybeRollover(a)!;
    const rb = maybeRollover(b)!;
    expect(fingerprint(a)).toBe(fingerprint(b));
    // Review ids differ by the module counter only for generated players; prospects use seeded ids.
    expect(JSON.stringify(ra.intake)).toBe(JSON.stringify(rb.intake));
    expect(JSON.stringify(ra.changes.map(({ id, ...c }) => c))).toBe(JSON.stringify(rb.changes.map(({ id, ...c }) => c)));
    expect(ra.retired).toEqual(rb.retired);
  });
  test('different seeds diverge', () => {
    const a = newGame(78);
    const b = newGame(79);
    runRollover(a);
    runRollover(b);
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe('CPU ladder', () => {
  test('clubs drift (some up, some down), keep their seeds and regenerate stable squads', () => {
    const s = newGame(60);
    const seeds = s.ladder.map((c) => c.seed);
    const elos = s.ladder.map((c) => c.elo);
    const oldSquad = ladderSquad(s.ladder[0]).map((p) => p.last);
    runRollover(s);
    expect(s.ladder.map((c) => c.seed)).toEqual(seeds);
    const moves = s.ladder.map((c, i) => c.elo - elos[i]);
    expect(moves.some((m) => m > 0)).toBe(true);
    expect(moves.some((m) => m < 0)).toBe(true);
    expect(s.ladder.every((c) => c.era === 1)).toBe(true);
    // Same club and era always produce the same squad; a new era is a new squad.
    expect(ladderSquad(s.ladder[0]).map((p) => p.last)).toEqual(ladderSquad(s.ladder[0]).map((p) => p.last));
    expect(ladderSquad(s.ladder[0]).map((p) => p.last)).not.toEqual(oldSquad);
  });
  test('an era-less club generates the same squad as before the feature existed', () => {
    const s = newGame(61);
    const c = s.ladder[2];
    const base = ladderSquad(c).map((p) => `${p.first} ${p.last}`);
    c.era = 0;
    expect(ladderSquad(c).map((p) => `${p.first} ${p.last}`)).toEqual(base);
  });
});

describe('older saves', () => {
  /** What a save from before the club calendar looked like. */
  function oldSave(): Save {
    const s = newGame(70);
    const raw = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    for (const k of ['week', 'year', 'review', 'offers']) delete raw[k];
    return raw as unknown as Save;
  }

  test('isSave still accepts them, and ensureProgressionFields fills defaults', () => {
    const o = oldSave();
    expect(isSave(o)).toBe(true);
    ensureProgressionFields(o);
    expect(o.week).toBe(0);
    expect(o.year).toBe(1);
    expect(o.review).toBeNull();
    expect(o.offers).toEqual([]);
  });

  test('a long history migrates to a week count and the right year without an instant rollover', () => {
    const o = oldSave();
    for (let k = 0; k < 23; k++) o.history.push({ opponent: 'A', opponentShort: 'A', goalsFor: 1, goalsAgainst: 0, ranked: k % 2 === 0, eloBefore: 1000, eloAfter: 1000, scorers: [], ...(k % 2 ? { competition: 'League matchday 1' } : {}) });
    o.history.push({ opponent: 'A', opponentShort: 'A', goalsFor: 1, goalsAgainst: 0, ranked: false, eloBefore: 1000, eloAfter: 1000, scorers: [] }); // a friendly
    expect(maybeRollover(o)).toBeNull();
    expect(o.week).toBe(23);
    expect(o.year).toBe(3);
    expect(o.history.at(-1)!.week).toBeUndefined();
    expect(o.history[22].week).toBe(23);
  });

  test('they round-trip through JSON and play on (a rollover works on a migrated save)', () => {
    const o = oldSave();
    ensureProgressionFields(o);
    const again = JSON.parse(JSON.stringify(o)) as Save;
    expect(isSave(again)).toBe(true);
    playWeeks(again, SEASON_WEEKS);
    expect(maybeRollover(again)).not.toBeNull();
    expect(isSave(JSON.parse(JSON.stringify(again)))).toBe(true);
  });

  test('isSave rejects malformed new fields', () => {
    const s = newGame(71) as unknown as Record<string, unknown>;
    expect(isSave({ ...s, week: 'ten' })).toBe(false);
    expect(isSave({ ...s, offers: 'none' })).toBe(false);
  });

  test('players saved before scouting have no fog', () => {
    const p: Player = generatePlayer(makeRng(1), { quality: 50, age: 20 });
    expect(p.scout).toBeUndefined();
    expect(scoutedPotential(p).exact).toBe(true);
  });
});
