import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { recordCupMatch, recordSeasonMatch, startCup, startSeason, type QuickSim } from '../src/meta/competitions.ts';
import { applyResult, buyPlayer, isSave, newGame, train, type MatchRecord, type Save } from '../src/meta/game.ts';
import { setCrest, setKit } from '../src/meta/identity.ts';
import {
  award,
  claimMilestone,
  clubLevel,
  cupFinishXp,
  ensureLevelFields,
  isUnlocked,
  leagueFinishXp,
  levelForXp,
  levelText,
  markUnlocksSeen,
  marketSize,
  matchXp,
  MAX_LEVEL,
  nextUnlocks,
  nextUnlockText,
  pendingUnlocks,
  replaySlots,
  retroXp,
  squadCap,
  totalXpForLevel,
  unlockOf,
  UNLOCKS,
  XP,
  xpSummary,
  xpToClear,
} from '../src/meta/levels.ts';
import { maybeRollover, SEASON_WEEKS } from '../src/meta/progression.ts';

const atLevel = (seed: number, level: number): Save => {
  const s = newGame(seed);
  s.xp = totalXpForLevel(level);
  return s;
};

/** A quick sim that needs no engine: the first club always wins 1-0. */
const homeWins: QuickSim = () => ({ ga: 1, gb: 0 });

const rec = (gf: number, ga: number, extra: Partial<MatchRecord> = {}): MatchRecord => ({
  opponent: 'A', opponentShort: 'A', goalsFor: gf, goalsAgainst: ga, ranked: true, eloBefore: 1000, eloAfter: 1000, scorers: [], ...extra,
});

/** What a save from before levels looked like: no xp, no unlocksSeen, no milestones. */
function preLevels(s: Save): Save {
  const raw = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  for (const k of ['xp', 'unlocksSeen', 'milestones']) delete raw[k];
  return raw as unknown as Save;
}

describe('the XP curve', () => {
  test('clearing level L takes 100 * L XP', () => {
    expect(xpToClear(1)).toBe(100);
    expect(xpToClear(2)).toBe(200);
    expect(xpToClear(50)).toBe(5_000);
    expect(xpToClear(98)).toBe(9_800);
    expect(xpToClear(99)).toBe(9_900);
  });
  test('total XP to reach a level', () => {
    expect(totalXpForLevel(1)).toBe(0);
    expect(totalXpForLevel(2)).toBe(100);
    expect(totalXpForLevel(3)).toBe(300);
    expect(totalXpForLevel(5)).toBe(1_000);
    expect(totalXpForLevel(10)).toBe(4_500);
    expect(totalXpForLevel(99)).toBe(485_100);
    let sum = 0;
    for (let l = 1; l < MAX_LEVEL; l++) sum += xpToClear(l);
    expect(sum).toBe(485_100);
  });
  test('level boundaries', () => {
    expect(levelForXp(0)).toEqual({ level: 1, intoLevel: 0, needed: 100, maxed: false });
    expect(levelForXp(99)).toEqual({ level: 1, intoLevel: 99, needed: 100, maxed: false });
    expect(levelForXp(100)).toEqual({ level: 2, intoLevel: 0, needed: 200, maxed: false });
    expect(levelForXp(299).level).toBe(2);
    expect(levelForXp(300).level).toBe(3);
    expect(levelForXp(830)).toEqual({ level: 4, intoLevel: 230, needed: 400, maxed: false });
    expect(levelForXp(485_099)).toEqual({ level: 98, intoLevel: 9_799, needed: 9_800, maxed: false });
    expect(levelForXp(485_100)).toEqual({ level: 99, intoLevel: 0, needed: 9_900, maxed: false });
    expect(levelForXp(494_999).maxed).toBe(false);
    expect(levelForXp(495_000)).toEqual({ level: 99, intoLevel: 9_900, needed: 9_900, maxed: true });
    // XP keeps counting past the cap.
    expect(levelForXp(2_000_000)).toEqual({ level: 99, intoLevel: 2_000_000 - 485_100, needed: 9_900, maxed: true });
  });
  test('bad input is level 1', () => {
    expect(levelForXp(-5).level).toBe(1);
    expect(levelForXp(Number.NaN).level).toBe(1);
  });
  test('header text', () => {
    expect(levelText(levelForXp(830))).toBe('Level 4 · 230 / 400 XP');
    expect(levelText(levelForXp(495_000))).toBe('Level 99 · Max level');
  });
});

describe('unlock table', () => {
  test('the schedule the owner asked for', () => {
    const at = Object.fromEntries(UNLOCKS.map((u) => [u.id, u.level]));
    expect(at).toMatchObject({ club: 1, squad: 1, ranked: 1, practice: 1, training: 2, transfers: 3, ladder: 4, cup: 5, 'practice-hard': 5, replays: 6, local2p: 7, league: 8, calendar: 10, link: 12 });
    expect(at).toMatchObject({ 'squad-15': 15, crest: 18, 'market-20': 20, kit: 22, scouting: 25, 'squad-30': 30, 'win-bonus': 35, 'replays-40': 40, 'squad-50': 50 });
  });
  test('sorted by level, unique ids, all within 1..99, perks after the features', () => {
    const levels = UNLOCKS.map((u) => u.level);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(new Set(UNLOCKS.map((u) => u.id)).size).toBe(UNLOCKS.length);
    expect(levels.every((l) => l >= 1 && l <= MAX_LEVEL)).toBe(true);
    expect(UNLOCKS.filter((u) => u.kind === 'feature').every((u) => u.level <= 12)).toBe(true);
    expect(UNLOCKS.at(-1)!.level).toBe(99);
  });
  test('lookup at level 1, at a boundary, and at 99', () => {
    const s = newGame(1);
    expect(clubLevel(s)).toBe(1);
    expect(isUnlocked(s, 'squad')).toBe(true);
    expect(isUnlocked(s, 'training')).toBe(false);
    expect(isUnlocked(s, 'cup')).toBe(false);
    s.xp = totalXpForLevel(5) - 1;
    expect(isUnlocked(s, 'cup')).toBe(false);
    s.xp += 1;
    expect(isUnlocked(s, 'cup')).toBe(true);
    expect(isUnlocked(s, 'practice-hard')).toBe(true);
    expect(isUnlocked(s, 'replays')).toBe(false);
    const top = atLevel(2, 99);
    expect(UNLOCKS.every((u) => isUnlocked(top, u.id))).toBe(true);
    expect(nextUnlocks(top)).toEqual([]);
    expect(nextUnlockText(top)).toBeNull();
  });
  test('next unlock teaser', () => {
    const s = newGame(3);
    s.xp = 660; // level 4, 340 short of level 5
    expect(nextUnlocks(s).map((u) => u.id)).toEqual(['cup', 'practice-hard']);
    expect(nextUnlockText(s)).toBe('The Cup and Practice Hard at level 5 — 340 XP to go');
    s.xp = totalXpForLevel(10);
    expect(nextUnlockText(s)).toBe('Link two tabs at level 12 — 2,100 XP to go');
  });
  test('pending unlocks are what the level-up dialog lists; closing it marks them seen', () => {
    const s = newGame(4);
    expect(pendingUnlocks(s)).toEqual([]);
    s.xp = totalXpForLevel(5);
    expect(pendingUnlocks(s).map((u) => u.id)).toEqual(['training', 'transfers', 'ladder', 'cup', 'practice-hard']);
    markUnlocksSeen(s);
    expect(pendingUnlocks(s)).toEqual([]);
    // Once unlocked, always unlocked: losing XP (a rebalance) doesn't take a feature away.
    s.xp = 0;
    expect(isUnlocked(s, 'cup')).toBe(true);
    expect(isUnlocked(s, 'replays')).toBe(false);
  });
  test('perks: squad cap, market size, replay shelf', () => {
    expect(squadCap(atLevel(1, 14))).toBe(14);
    expect(squadCap(atLevel(1, 15))).toBe(15);
    expect(squadCap(atLevel(1, 30))).toBe(16);
    expect(squadCap(atLevel(1, 50))).toBe(17);
    expect(marketSize(atLevel(1, 19))).toBe(10);
    expect(marketSize(atLevel(1, 20))).toBe(12);
    expect(marketSize(atLevel(1, 80))).toBe(14);
    expect(replaySlots(atLevel(1, 39))).toBe(5);
    expect(replaySlots(atLevel(1, 40))).toBe(8);
    expect(replaySlots(atLevel(1, 65))).toBe(10);
  });
  test('crest and kit changes wait for their perks', () => {
    const s = atLevel(5, 17);
    expect(setCrest(s, 'hoops')).toBe(false);
    s.xp = totalXpForLevel(18);
    expect(setCrest(s, 'hoops')).toBe(true);
    expect(s.club.crest).toBe('hoops');
    expect(setKit(s, '#c8102e', '#ffffff')).toBe(false);
    s.xp = totalXpForLevel(22);
    expect(setKit(s, '#c8102e', '#c8102e')).toBe(false);
    expect(setKit(s, '#c8102e', '#123456')).toBe(false);
    expect(setKit(s, '#c8102e', '#ffffff')).toBe(true);
    expect([s.club.primary, s.club.secondary]).toEqual(['#c8102e', '#ffffff']);
  });
});

describe('XP awards', () => {
  test('per result', () => {
    expect(matchXp('ranked', 3, 1)).toEqual([{ label: 'win', xp: 120 }, { label: '3 goals', xp: 30 }]);
    expect(matchXp('ranked', 1, 0)).toEqual([{ label: 'win', xp: 120 }, { label: '1 goal', xp: 10 }, { label: 'clean sheet', xp: 20 }]);
    expect(matchXp('ranked', 0, 0)).toEqual([{ label: 'draw', xp: 80 }, { label: 'clean sheet', xp: 20 }]);
    expect(matchXp('competition', 0, 2)).toEqual([{ label: 'loss', xp: 50 }]);
    expect(matchXp('practice', 5, 0, false, 'easy')).toEqual([{ label: 'practice (Easy)', xp: 30 }]);
    expect(matchXp('practice', 0, 3, false, 'normal')[0].xp).toBe(40);
    expect(matchXp('practice', 0, 3, false, 'hard')[0].xp).toBe(60);
  });
  test('forfeits give nothing', () => {
    expect(matchXp('ranked', 0, 3, true)).toEqual([]);
    const s = newGame(10);
    const r = applyResult(s, s.ladder[0], { name: 'A', short: 'A' }, 0, 3, true, [], undefined, true);
    expect(r.xp.total).toBe(0);
    expect(s.xp).toBe(0);
  });
  test('applyResult adds match XP and the first ranked win once', () => {
    const s = newGame(11);
    const a = applyResult(s, s.ladder[0], { name: 'A', short: 'A' }, 3, 1, true, []);
    expect(a.xp.total).toBe(120 + 30 + 100);
    expect(xpSummary(a.xp)).toBe('+250 XP: win 120, 3 goals 30, first ranked win 100');
    expect(a.xp.levelBefore).toBe(1);
    expect(a.xp.levelAfter).toBe(2);
    const b = applyResult(s, s.ladder[1], { name: 'B', short: 'B' }, 2, 0, true, []);
    expect(b.xp.total).toBe(120 + 20 + 20);
    const c = applyResult(s, null, { name: 'Veterans Select', short: 'VET' }, 0, 1, false, [], undefined, false, 'hard');
    expect(c.xp.total).toBe(60);
    expect(s.xp).toBe(250 + 160 + 60);
  });
  test('training sessions and the first signing', () => {
    const s = newGame(12);
    s.budget = 50_000_000;
    train(s, s.squad[0].id, 'passing');
    expect(s.xp).toBe(XP.trainingSession);
    const first = buyPlayer(s, s.market[0].id);
    expect(first.message).toMatch(/\+50 XP/);
    buyPlayer(s, s.market[0].id);
    expect(s.xp).toBe(XP.trainingSession + 50);
  });
  test('milestones are claimed once', () => {
    const s = newGame(13);
    expect(award(s, [claimMilestone(s, 'tutorial')]).total).toBe(100);
    expect(award(s, [claimMilestone(s, 'tutorial')]).total).toBe(0);
    expect(s.milestones).toEqual(['tutorial']);
    expect(clubLevel(s)).toBe(2);
  });
  test('cup and league finishing bonuses', () => {
    expect(cupFinishXp(0, false)).toBeNull();
    expect(cupFinishXp(0, true)).toBeNull();
    expect(cupFinishXp(1, false)!.xp).toBe(100);
    expect(cupFinishXp(2, false)!.xp).toBe(200);
    expect(cupFinishXp(2, true)!.xp).toBe(500);
    expect(leagueFinishXp(1)!.xp).toBe(800);
    expect(leagueFinishXp(2)!.xp).toBe(400);
    expect(leagueFinishXp(8)!.xp).toBe(50);
  });
  test('winning the cup pays the match, the trophy bonus and the first trophy', () => {
    const s = atLevel(14, 5);
    startCup(s);
    let last = recordCupMatch(s, 2, 0, [], homeWins);
    expect(last.summary.xp.total).toBe(120 + 20 + 20);
    recordCupMatch(s, 2, 0, [], homeWins);
    last = recordCupMatch(s, 2, 0, [], homeWins);
    expect(last.trophy).not.toBeNull();
    expect(last.summary.xp.parts.map((p) => p.label)).toEqual(['win', '2 goals', 'clean sheet', 'cup winners', 'first trophy']);
    expect(last.summary.xp.total).toBe(160 + 500 + 200);
  });
  test('a forfeited cup final pays nothing', () => {
    const s = atLevel(15, 5);
    startCup(s);
    recordCupMatch(s, 2, 0, [], homeWins);
    recordCupMatch(s, 2, 0, [], homeWins);
    const before = s.xp!;
    const out = recordCupMatch(s, 0, 3, [], homeWins, true);
    expect(out.summary.xp.total).toBe(0);
    expect(s.xp).toBe(before);
  });
  test('the league pays its finish on the last matchday', () => {
    const s = atLevel(16, 8);
    startSeason(s);
    let out = recordSeasonMatch(s, 5, 0, [], homeWins);
    for (let d = 1; d < 7; d++) out = recordSeasonMatch(s, 5, 0, [], homeWins);
    expect(out.trophy).not.toBeNull();
    expect(out.summary.xp.parts.map((p) => p.label)).toContain('league champions');
    expect(out.summary.xp.parts.map((p) => p.label)).toContain('first trophy');
  });
});

describe('the calendar waits for level 10', () => {
  test('no week passes and nothing rolls over before it unlocks', () => {
    const s = newGame(20);
    for (let k = 0; k < SEASON_WEEKS + 2; k++) applyResult(s, s.ladder[k % 5], { name: 'X', short: 'X' }, 0, 1, true, []);
    expect(clubLevel(s)).toBeLessThan(10);
    expect(s.week).toBe(0);
    expect(maybeRollover(s)).toBeNull();
    expect(s.history.every((m) => m.week === undefined)).toBe(true);
  });
  test('it starts counting with the first match after it unlocks', () => {
    const s = newGame(21);
    s.xp = totalXpForLevel(10) - 10;
    applyResult(s, s.ladder[0], { name: 'X', short: 'X' }, 1, 0, true, []); // crosses into level 10
    expect(isUnlocked(s, 'calendar')).toBe(true);
    expect(s.week).toBe(0);
    applyResult(s, s.ladder[1], { name: 'X', short: 'X' }, 1, 0, true, []);
    expect(s.week).toBe(1);
  });
});

describe('saves from before levels', () => {
  test('isSave still accepts them and rejects malformed level fields', () => {
    const old = preLevels(newGame(30));
    expect(isSave(old)).toBe(true);
    expect(isSave({ ...newGame(30), xp: 'lots' })).toBe(false);
    expect(isSave({ ...newGame(30), unlocksSeen: 'all' })).toBe(false);
  });
  test('a fresh-looking old save starts at level 1 with the level-1 features', () => {
    const old = preLevels(newGame(31));
    ensureLevelFields(old);
    expect(old.xp).toBe(0);
    expect(clubLevel(old)).toBe(1);
    expect(old.unlocksSeen).toEqual(['club', 'squad', 'ranked', 'practice']);
    expect(pendingUnlocks(old)).toEqual([]);
  });
  test('retro XP from the match history uses the same table', () => {
    const s = newGame(32);
    s.history.push(rec(3, 1), rec(0, 0), rec(1, 2), rec(2, 0, { ranked: false, competition: 'Cup quarter-final' }), rec(4, 0, { ranked: false, opponent: 'Reserve XI' }));
    s.trainingPoints = 6 + 3 + 2 + 2 + 2 + 1 - 4; // four sessions spent
    const old = preLevels(s);
    const expected = 150 + 100 + 60 + 160 + 30 + 4 * 5 + 100; // matches, sessions, first ranked win
    expect(retroXp(old).xp).toBe(expected);
    ensureLevelFields(old);
    expect(old.xp).toBe(expected);
    expect(old.milestones).toEqual(['first-win']);
    // Nothing reached by the retro XP pops a level-up dialog.
    expect(pendingUnlocks(old)).toEqual([]);
    expect(clubLevel(old)).toBe(levelForXp(expected).level);
  });
  test('cup runs, titles and trophies count', () => {
    const s = newGame(33);
    s.history.push(
      rec(1, 0, { ranked: false, competition: 'Cup quarter-final' }),
      rec(1, 0, { ranked: false, competition: 'Cup semi-final' }),
      rec(1, 0, { ranked: false, competition: 'Cup final' }),
    );
    s.trophies = [{ kind: 'cup', title: 'Cup 1', edition: 1, atMatch: 3 }];
    s.trainingPoints = 6 + 6;
    const r = retroXp(preLevels(s));
    expect(r.xp).toBe(3 * 150 + 500 + 200); // three 1-0 wins, the cup, the first trophy
    expect(r.milestones).toEqual(['first-trophy']);
  });
  test('features in use stay unlocked whatever the level', () => {
    const s = newGame(34);
    startCup(s);
    startSeason(s);
    s.week = 4;
    s.offers = [s.squad[0]];
    const old = preLevels(s);
    ensureLevelFields(old);
    expect(clubLevel(old)).toBeLessThan(5);
    for (const id of ['cup', 'league', 'calendar'] as const) expect(isUnlocked(old, id)).toBe(true);
    expect(old.unlocksSeen).toContain('cup');
    expect(old.unlocksSeen).toContain('league');
    expect(old.unlocksSeen).toContain('calendar');
    // They stay unlocked after the cup and season are cleared, because they were seen.
    old.cup = null;
    old.season = null;
    old.week = 0;
    old.offers = [];
    expect(isUnlocked(old, 'cup')).toBe(true);
    expect(isUnlocked(old, 'calendar')).toBe(true);
    expect(isUnlocked(old, 'replays')).toBe(false);
  });
  test('trophies alone keep competitions open', () => {
    const s = newGame(35);
    s.trophies = [{ kind: 'season', title: 'League 1', edition: 1, atMatch: 7 }];
    expect(isUnlocked(s, 'league')).toBe(true);
    expect(isUnlocked(s, 'cup')).toBe(false);
  });
  test('a migrated save keeps the calendar it was already counting', () => {
    const s = newGame(36);
    for (let k = 0; k < 4; k++) s.history.push(rec(1, 0, { week: k + 1 }));
    s.week = 4;
    const old = preLevels(s);
    ensureLevelFields(old);
    applyResult(old, old.ladder[0], { name: 'X', short: 'X' }, 1, 0, true, []);
    expect(old.week).toBe(5);
  });
  test('ensureLevelFields is idempotent and round-trips through JSON', () => {
    const s = preLevels(newGame(37));
    ensureLevelFields(s);
    const once = JSON.stringify(s);
    ensureLevelFields(s);
    expect(JSON.stringify(s)).toBe(once);
    expect(isSave(JSON.parse(once))).toBe(true);
  });
  test('unlockOf finds every row', () => {
    for (const u of UNLOCKS) expect(unlockOf(u.id)).toBe(u);
  });
});

describe('docs', () => {
  test('the unlock table in docs/ROADMAP.md matches UNLOCKS', () => {
    const md = readFileSync(new URL('../docs/ROADMAP.md', import.meta.url), 'utf8');
    const rows = md.split('\n').filter((l) => /^\| \d+ \| (Feature|Perk) \|/.test(l));
    expect(rows).toEqual(UNLOCKS.map((u) => `| ${u.level} | ${u.kind === 'feature' ? 'Feature' : 'Perk'} | ${u.name} | ${u.text} |`));
  });
});
