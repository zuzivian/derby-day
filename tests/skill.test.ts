import { describe, expect, test } from 'bun:test';
import { cpuTeam, ladderSquad } from '../src/meta/club.ts';
import { clubTeam, isSave, newGame, pickOpponent, type MatchRecord } from '../src/meta/game.ts';
import { winChance as gameWinChance } from '../src/meta/game.ts';
import {
  BAND_DOWN,
  BAND_UP,
  bandedSkill,
  ensureSkill,
  EST_MAX,
  EST_MIN,
  HOME_SKILL,
  learnSkill,
  NEW_EST,
  opponentSetup,
  outlook,
  setupStrength,
  skillOf,
  TARGET_WIN,
  winChance,
} from '../src/meta/skill.ts';
import { AI_SKILL_MIN, humanAuto, IDLE_TICKS } from '../src/sim/ai.ts';
import { createMatch, step } from '../src/sim/match.ts';

const rec = (gf: number, ga: number, ranked = true): MatchRecord => ({ opponent: 'A', opponentShort: 'A', goalsFor: gf, goalsAgainst: ga, ranked, eloBefore: 1000, eloAfter: 1000, scorers: [] });

describe('the hidden skill estimate', () => {
  test('a new club starts as a newcomer, and the estimate is not Elo', () => {
    const s = newGame(1);
    expect(skillOf(s)).toEqual({ est: NEW_EST, n: 0 });
    expect(s.club.elo).toBe(1000);
  });

  test('a win moves it up, a defeat down, a heavier one further; it counts the matches', () => {
    const base = newGame(2);
    const opp = pickOpponent(base);
    const home = clubTeam(base, HOME_SKILL);
    const away = opponentSetup(base, opp, home);
    const after = (gf: number, ga: number) => {
      const s = newGame(2);
      return learnSkill(s, home, away, gf, ga);
    };
    expect(after(1, 0).est).toBeGreaterThan(NEW_EST);
    expect(after(0, 1).est).toBeLessThan(NEW_EST);
    expect(after(0, 4).est).toBeLessThan(after(0, 1).est);
    expect(after(4, 0).est).toBeGreaterThan(after(1, 0).est);
    expect(after(1, 1).n).toBe(1);
  });

  test('it settles: a long run of results at the level it expects barely moves it, and it never runs away', () => {
    const s = newGame(3);
    const home = clubTeam(s, HOME_SKILL);
    const away = cpuTeam(s.ladder[0], ladderSquad(s.ladder[0]));
    for (let i = 0; i < 200; i++) learnSkill(s, home, away, 9, 0);
    expect(skillOf(s).est).toBeLessThanOrEqual(EST_MAX);
    for (let i = 0; i < 400; i++) learnSkill(s, home, away, 0, 9);
    expect(skillOf(s).est).toBeGreaterThanOrEqual(EST_MIN);
    // Later matches move it less than the first few.
    const a = newGame(4);
    const first = learnSkill(a, home, away, 1, 0).est - NEW_EST;
    for (let i = 0; i < 20; i++) learnSkill(a, home, away, 1, 1);
    const before = skillOf(a).est;
    expect(learnSkill(a, home, away, 1, 0).est - before).toBeLessThan(first);
  });

  test('the model: a better player, a weaker CPU or a weaker squad all raise the win chance; the three add up to one', () => {
    const s = newGame(5);
    const opp = s.ladder[0];
    const home = clubTeam(s, HOME_SKILL);
    const away = cpuTeam(opp, ladderSquad(opp), 0.3);
    const o = outlook(0.2, home, away);
    expect(o.win + o.draw + o.loss).toBeCloseTo(1, 9);
    expect(outlook(0.5, home, away).win).toBeGreaterThan(o.win);
    expect(outlook(0.2, home, { ...away, aiSkill: 0.1 }).win).toBeGreaterThan(o.win);
    const weaker = { ...away, players: away.players.map((p) => ({ ...p, attrs: Object.fromEntries(Object.entries(p.attrs).map(([k, v]) => [k, v * 0.8])) as typeof p.attrs })) };
    expect(setupStrength(weaker)).toBeLessThan(setupStrength(away));
    expect(outlook(0.2, home, weaker).win).toBeGreaterThan(o.win);
  });
});

describe('matchmaking: the CPU skill band', () => {
  test('the CPU plays at the skill that gives the player a fair chance, when that is inside the band', () => {
    const natural = 0.4;
    const est = 0.5;
    const a = bandedSkill(est, natural, 0);
    expect(a).toBeGreaterThan(natural - BAND_DOWN);
    expect(a).toBeLessThan(natural + BAND_UP);
    const s = newGame(6);
    s.skill = { est, n: 10 };
    const home = clubTeam(s, HOME_SKILL);
    const nat = cpuTeam(s.ladder[0], ladderSquad(s.ladder[0]));
    const shaped = { ...nat, aiSkill: bandedSkill(est, nat.aiSkill, setupStrength(nat) - setupStrength(home)) };
    if (shaped.aiSkill > nat.aiSkill - BAND_DOWN + 1e-6 && shaped.aiSkill < nat.aiSkill + BAND_UP - 1e-6) expect(outlook(est, home, shaped).win).toBeCloseTo(TARGET_WIN, 2);
  });

  test('a beginner meets a slower CPU and a strong player a sharper one, never past the band, a rookie side or 1', () => {
    for (const natural of [0.15, 0.4, 0.75]) {
      const lo = bandedSkill(-0.5, natural, 0);
      const hi = bandedSkill(1.3, natural, 0);
      expect(lo).toBeCloseTo(Math.max(AI_SKILL_MIN, natural - BAND_DOWN), 9);
      expect(hi).toBeCloseTo(Math.min(1, natural + BAND_UP), 9);
      expect(bandedSkill(0.1, natural, 0)).toBeLessThanOrEqual(bandedSkill(0.6, natural, 0));
    }
  });

  test('the opponent keeps its own squad, shape and name: only the CPU skill changes', () => {
    const s = newGame(7);
    const opp = pickOpponent(s);
    const home = clubTeam(s, HOME_SKILL);
    const nat = cpuTeam(opp, ladderSquad(opp));
    s.skill = { est: -0.3, n: 5 };
    const easy = opponentSetup(s, opp, home);
    s.skill = { est: 1, n: 5 };
    const hard = opponentSetup(s, opp, home);
    // (Player ids are minted afresh each time a squad is generated, so compare the rest.)
    const shape = (t: typeof nat) => ({ ...t, aiSkill: 0, players: t.players.map((p) => ({ ...p, id: '' })) });
    expect(shape(easy)).toEqual(shape(nat));
    expect(easy.aiSkill).toBeLessThan(hard.aiSkill);
  });

  test('the win chance shown is the model chance against the opponent as he will play, and game.ts exports the same function', () => {
    const s = newGame(8);
    const opp = pickOpponent(s);
    const home = clubTeam(s, HOME_SKILL);
    expect(winChance(s, opp)).toBeCloseTo(outlook(skillOf(s).est, home, opponentSetup(s, opp, home)).win, 12);
    expect(gameWinChance).toBe(winChance);
    s.skill = { est: 0.9, n: 20 };
    const strong = winChance(s, opp);
    s.skill = { est: -0.4, n: 20 };
    expect(winChance(s, opp)).toBeLessThan(strong);
  });
});

describe('save migration', () => {
  test('a save from before the estimate gets one from its last ranked results; a good record starts higher', () => {
    const winner = newGame(9);
    winner.history = Array.from({ length: 10 }, () => rec(2, 0));
    delete winner.skill;
    ensureSkill(winner);
    const loser = newGame(9);
    loser.history = Array.from({ length: 10 }, () => rec(0, 2));
    delete loser.skill;
    ensureSkill(loser);
    expect(skillOf(winner).est).toBeGreaterThan(NEW_EST);
    expect(skillOf(loser).est).toBeLessThan(NEW_EST);
    expect(skillOf(winner).n).toBe(10);
    // Friendlies don't count, and an estimate already there is kept.
    const fr = newGame(9);
    fr.history = Array.from({ length: 10 }, () => rec(5, 0, false));
    ensureSkill(fr);
    expect(skillOf(fr).est).toBeCloseTo(NEW_EST, 9);
    winner.skill = { est: 0.77, n: 30 };
    ensureSkill(winner);
    expect(skillOf(winner)).toEqual({ est: 0.77, n: 30 });
  });

  test('a broken estimate is repaired, and never makes the save invalid', () => {
    const s = newGame(10);
    s.skill = { est: Number.NaN, n: 2 };
    expect(isSave(s)).toBe(true);
    ensureSkill(s);
    expect(Number.isFinite(skillOf(s).est)).toBe(true);
    const old = JSON.parse(JSON.stringify(newGame(11)));
    delete old.skill;
    expect(isSave(old)).toBe(true);
  });
});

describe('a human who gives no input', () => {
  test('with no pointer and no keys for IDLE_TICKS, the CPU positions his player; any input hands him back', () => {
    const s0 = newGame(12);
    const home = clubTeam(s0, HOME_SKILL);
    const away = cpuTeam(s0.ladder[0], ladderSquad(s0.ladder[0]));
    const s = createMatch({ seed: 3, home, away, humans: [true, false] });
    while (s.phase !== 'play') step(s, {});
    for (let i = 0; i < IDLE_TICKS + 5; i++) step(s, {});
    expect(humanAuto(s, 0)).toBe(true);
    step(s, { dir: { x: 1, y: 0 } });
    expect(humanAuto(s, 0)).toBe(false);
    // A pointer resting on the pitch is a command ("stay there"), never idle.
    for (let i = 0; i < IDLE_TICKS + 5; i++) step(s, { cursor: { x: 40, y: 30 } });
    expect(s.idleTicks?.[0]).toBe(0);
  });
});
