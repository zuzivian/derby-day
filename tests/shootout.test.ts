import { describe, expect, test } from 'bun:test';
import {
  KICKS_PER_SIDE,
  MAX_POWER,
  SUDDEN_DEATH_CAP,
  createShootout,
  cpuKeeperDive,
  cpuTakerAim,
  finalScore,
  forfeitShootout,
  marks,
  nextTurn,
  penaltySide,
  matchPenaltySides,
  planKick,
  playKick,
  recordKick,
  resolveKick,
  runShootout,
  skyChance,
  type PenaltySide,
  type Shootout,
} from '../src/meta/shootout.ts';
import { recordCupMatch, startCup, yourTie, type QuickSim } from '../src/meta/competitions.ts';
import { newGame } from '../src/meta/game.ts';
import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { shortName } from '../src/meta/player.ts';
import { createMatch } from '../src/sim/match.ts';
import { issueCard } from '../src/sim/rules.ts';
import { makeRng } from '../src/sim/rng.ts';

const side = (name: string, shooting: number, goalkeeping: number): PenaltySide => ({
  name,
  takers: Array.from({ length: 5 }, (_, i) => ({ name: `${name}${i + 1}`, shooting })),
  keeper: { name: `${name} GK`, goalkeeping },
});

const A = side('A', 0.6, 0.6);
const B = side('B', 0.6, 0.6);

/** Feed a scripted sequence of outcomes (true = goal) in turn order. */
function script(s: Shootout, plan: (side: 0 | 1, round: number) => boolean): void {
  for (let guard = 0; !s.done && guard < 500; guard++) {
    const t = nextTurn(s)!;
    recordKick(s, t.side, t.taker.name, plan(t.side, t.round) ? 'goal' : 'saved');
  }
}

describe('resolveKick', () => {
  const base = { aim: { x: 0.5, y: 0.3 }, power: 0.6, shooting: 0.6, goalkeeping: 0.6, dive: 1 as const };

  test('is deterministic for the same rng state and draws four numbers whatever happens', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r1 = makeRng(seed);
      const r2 = makeRng(seed);
      const x = resolveKick(r1, base);
      const y = resolveKick(r2, base);
      expect(x).toEqual(y);
      const r3 = makeRng(seed);
      resolveKick(r3, { ...base, power: 1.4 });
      expect(r3.s).toBe(r1.s);
    }
  });

  test('power at or over the maximum always skies it, whatever the aim, skill or keeper', () => {
    for (let seed = 1; seed <= 200; seed++) {
      for (const power of [MAX_POWER, 1.1, 1.5]) {
        const res = resolveKick(makeRng(seed), { ...base, power, aim: { x: (seed % 7) / 7 - 0.4, y: 0.2 }, shooting: 1, dive: (seed % 3) - 1 as -1 | 0 | 1 });
        expect(res.outcome).toBe('over');
        expect(res.scored).toBe(false);
        expect(res.at.y).toBeGreaterThan(1);
      }
    }
    expect(skyChance(MAX_POWER)).toBe(1);
    expect(skyChance(0.5)).toBe(0);
    expect(skyChance(0.9)).toBeGreaterThan(0);
    expect(skyChance(0.9)).toBeLessThan(skyChance(0.99));
  });

  test('corners are riskier than the middle of the goal side, and a wrong-way keeper never saves', () => {
    const tally = (x: number, y: number, dive: -1 | 0 | 1) => {
      const out = { goal: 0, miss: 0, saved: 0 };
      for (let seed = 1; seed <= 3000; seed++) {
        const r = resolveKick(makeRng(seed), { aim: { x, y }, power: 0.65, shooting: 0.6, goalkeeping: 0.6, dive });
        if (r.outcome === 'goal') out.goal++;
        else if (r.outcome === 'saved') out.saved++;
        else out.miss++;
      }
      return out;
    };
    expect(tally(0.95, 0.92, -1).miss).toBeGreaterThan(tally(0.55, 0.4, -1).miss * 4);
    expect(tally(0.6, 0.4, -1).saved).toBe(0);
    expect(tally(0.6, 0.4, 1).saved).toBeGreaterThan(300);
  });

  test('better shooters hit the target more often', () => {
    const misses = (shooting: number) => {
      let n = 0;
      for (let seed = 1; seed <= 3000; seed++) if (['wide', 'over', 'post'].includes(resolveKick(makeRng(seed), { ...base, aim: { x: 0.8, y: 0.7 }, shooting, dive: -1 }).outcome)) n++;
      return n;
    };
    expect(misses(0.9)).toBeLessThan(misses(0.3));
  });
});

describe('cpu choices', () => {
  test('are seeded and in range', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const a = cpuTakerAim(makeRng(seed), 0.7);
      expect(a).toEqual(cpuTakerAim(makeRng(seed), 0.7));
      expect(Math.abs(a.aim.x)).toBeLessThanOrEqual(1);
      expect(a.aim.y).toBeGreaterThan(0);
      expect(a.aim.y).toBeLessThan(1);
      expect(a.power).toBeLessThan(MAX_POWER);
    }
  });

  test('a better keeper reads the shot more often', () => {
    const reads = (gk: number) => {
      let n = 0;
      for (let seed = 1; seed <= 4000; seed++) if (cpuKeeperDive(makeRng(seed), gk, { x: 0.7, y: 0.3 }) === 1) n++;
      return n;
    };
    expect(reads(0.95)).toBeGreaterThan(reads(0.1));
  });
});

describe('shootout format', () => {
  test('same seed, same shootout; different seeds differ', () => {
    const a = runShootout(7, A, B);
    const b = runShootout(7, A, B);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) outcomes.add(JSON.stringify(runShootout(seed, A, B).score));
    expect(outcomes.size).toBeGreaterThan(2);
  });

  test('always ends with a winner and never a level score, within a sane number of kicks', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const s = runShootout(seed, side('A', 0.3 + (seed % 7) / 10, 0.9), side('B', 0.9, 0.3 + (seed % 5) / 10));
      expect(s.done).toBe(true);
      expect(s.winner === 0 || s.winner === 1).toBe(true);
      if (!s.coinToss) expect(s.score[0]).not.toBe(s.score[1]);
      expect(s.kicks.length).toBeLessThanOrEqual(2 * (KICKS_PER_SIDE + SUDDEN_DEATH_CAP));
      expect(nextTurn(s)).toBeNull();
      expect(planKick(s)).toBeNull();
    }
  });

  test('best of five finishes early when the other side can no longer catch up', () => {
    // Side 0 scores everything and side 1 misses everything: decided at 3-0 after six kicks, not before.
    for (let seed = 1; seed <= 12; seed++) {
      const s = createShootout(seed, A, B);
      for (let k = 0; k < 4; k++) {
        const t = nextTurn(s)!;
        recordKick(s, t.side, t.taker.name, t.side === 0 ? 'goal' : 'saved');
      }
      expect(s.done).toBe(false);
      script(s, (sd) => sd === 0);
      expect(s.winner).toBe(0);
      expect(s.kicks.length).toBe(6);
      expect(s.score).toEqual([3, 0]);
    }
  });

  test('equal scores after five each go to sudden death and stop at the first round that separates them', () => {
    const s = createShootout(3, A, B);
    // 5-5, then in the first sudden-death round side 0 scores and side 1 misses.
    script(s, (sd, round) => round < KICKS_PER_SIDE || sd === 0);
    expect(s.coinToss).toBe(false);
    expect(s.taken).toEqual([6, 6]);
    expect(s.winner).toBe(0);
    expect(s.score).toEqual([6, 5]);
  });

  test('sudden death that never separates the sides is ended by the cap', () => {
    const s = createShootout(3, A, B);
    script(s, () => true);
    expect(s.done).toBe(true);
    expect(s.coinToss).toBe(true);
    expect(s.taken).toEqual([KICKS_PER_SIDE + SUDDEN_DEATH_CAP, KICKS_PER_SIDE + SUDDEN_DEATH_CAP]);
  });

  test('a mid-round lead in sudden death does not end it until both have kicked', () => {
    const s = createShootout(4, A, B);
    for (let k = 0; k < 2 * KICKS_PER_SIDE; k++) {
      const t = nextTurn(s)!;
      recordKick(s, t.side, t.taker.name, 'goal');
    }
    expect(s.taken).toEqual([5, 5]);
    expect(s.done).toBe(false);
    // Whoever kicks first in sudden death scores; the other has not kicked yet.
    const t = nextTurn(s)!;
    recordKick(s, t.side, t.taker.name, 'goal');
    expect(s.done).toBe(false);
    const u = nextTurn(s)!;
    expect(u.side).not.toBe(t.side);
    recordKick(s, u.side, u.taker.name, 'saved');
    expect(s.done).toBe(true);
    expect(s.winner).toBe(t.side);
  });

  test('takers alternate, start with the coin-toss side, and cycle through the lineup', () => {
    const s = createShootout(11, A, B);
    const seen: number[] = [];
    script(s, (_sd, round) => round < 5);
    for (const k of s.kicks) seen.push(k.side);
    for (let i = 0; i < seen.length; i++) expect(seen[i]).toBe(i % 2 === 0 ? s.first : 1 - s.first);
    expect(s.kicks[0].side).toBe(s.first);
    expect(s.kicks.filter((k) => k.side === 0).map((k) => k.taker).slice(0, 5)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
  });

  test('marks and finalScore', () => {
    const s = createShootout(5, A, B);
    expect(marks(s, 0)).toEqual([null, null, null, null, null]);
    const t = nextTurn(s)!;
    recordKick(s, t.side, t.taker.name, 'goal');
    expect(marks(s, t.side)[0]).toBe(true);
    forfeitShootout(s, 0);
    expect(s.winner).toBe(1);
    const [a, b] = finalScore(s);
    expect(b).toBeGreaterThan(a);
  });

  test('human choices change the outcome and the cpu fills in the rest', () => {
    const s1 = createShootout(21, A, B);
    const s2 = createShootout(21, A, B);
    const turn = nextTurn(s1)!;
    const p1 = playKick(s1, { aim: { x: 0, y: 0.4 }, power: 1.2, dive: 0 });
    expect(p1.result.outcome).toBe('over');
    expect(p1.turn.side).toBe(turn.side);
    const p2 = playKick(s2);
    expect(p2.aim).toEqual(planKick(createShootout(21, A, B))!.cpuAim);
  });
});

describe('penaltySide', () => {
  test('orders takers best shooter first and takes the keeper from slot one', () => {
    const save = newGame(77);
    const side1 = penaltySide(save.club.name, save.squad, save.lineup);
    expect(side1.takers.length).toBeGreaterThanOrEqual(KICKS_PER_SIDE);
    const gk = save.squad.find((p) => p.id === save.lineup[0])!;
    // Outfield players best first, then the keeper: nobody kicks twice before all eleven have.
    const outfield = side1.takers.slice(0, -1);
    for (let i = 1; i < outfield.length; i++) expect(outfield[i - 1].shooting).toBeGreaterThanOrEqual(outfield[i].shooting);
    expect(side1.takers.length).toBe(11);
    expect(side1.takers[10].name).toBe(shortName(gk));
    expect(side1.keeper.goalkeeping).toBeCloseTo(gk.attrs.goalkeeping / 100);
  });
});

describe('matchPenaltySides (Law 10)', () => {
  const drawn = () => {
    const [a, b] = generateLadder(9, 2);
    return createMatch({ seed: 3, home: cpuTeam(a, ladderSquad(a)), away: cpuTeam(b, ladderSquad(b)), humanTeam: 0 });
  };

  test('everyone on the pitch kicks, outfield best first and the keeper last, before anyone kicks twice', () => {
    const m = drawn();
    const [home, away] = matchPenaltySides(m);
    for (const [side, team] of [[home, 0], [away, 1]] as const) {
      expect(side.takers.length).toBe(11);
      const gk = m.players.find((p) => p.team === team && p.role === 'GK')!;
      expect(side.takers[10].name).toBe(gk.name);
      expect(side.keeper.name).toBe(gk.name);
      expect(new Set(side.takers.map((t) => t.name)).size).toBe(11);
      for (let i = 1; i < 10; i++) expect(side.takers[i - 1].shooting).toBeGreaterThanOrEqual(side.takers[i].shooting);
    }
    // Everyone scores, into sudden death: the first 11 kicks are 11 different players, then the order comes round again.
    const s = createShootout(5, home, away);
    const seen: string[] = [];
    for (let k = 0; k < 44 && !s.done; k++) {
      const turn = nextTurn(s)!;
      if (turn.side === 0) seen.push(turn.taker.name);
      recordKick(s, turn.side, turn.taker.name, 'goal');
    }
    expect(seen.length).toBe(22);
    expect(new Set(seen.slice(0, 11)).size).toBe(11);
    expect(seen.slice(11)).toEqual(seen.slice(0, 11));
  });

  test('a player sent off does not kick, the keeper at full time keeps goal, and the bigger side is cut to match', () => {
    const m = drawn();
    const off = m.players.find((p) => p.team === 0 && p.role === 'FWD')!;
    const gk = m.players.find((p) => p.team === 0 && p.role === 'GK')!;
    issueCard(m, off, 'red', 'excessive');
    issueCard(m, gk, 'red', 'excessive');
    const [home, away] = matchPenaltySides(m);
    expect(home.takers.length).toBe(9);
    expect(away.takers.length).toBe(9);
    expect(home.takers.some((t) => t.name === off.name || t.name === gk.name)).toBe(false);
    const stand = m.players.find((p) => p.team === 0 && p.role === 'GK' && !p.sentOff)!;
    expect(stand).toBeDefined();
    expect(home.keeper.name).toBe(stand.name);
    expect(home.takers[8].name).toBe(stand.name);
    // The away side leaves out its two weakest outfield shooters, and keeps its keeper.
    const awayOut = m.players.filter((p) => p.team === 1 && p.role !== 'GK').sort((x, y) => y.attrs.shooting - x.attrs.shooting);
    expect(away.takers.slice(0, 8).map((t) => t.name)).toEqual(awayOut.slice(0, 8).map((p) => p.name));
  });
});

describe('cup integration', () => {
  const sim: QuickSim = (_s, a, b) => (a.elo >= b.elo ? { ga: 2, gb: 1 } : { ga: 1, gb: 2 });

  test('a live shootout score settles your drawn tie, win or lose', () => {
    for (const you of [4, 2]) {
      const s = newGame(31);
      const cup = startCup(s);
      const tie = yourTie(s, cup)!;
      const home = tie.a === s.club.id;
      const out = recordCupMatch(s, 1, 1, [], sim, false, { you, opp: 3 });
      const done = cup.rounds[0].find((t) => t.a === s.club.id || t.b === s.club.id)!;
      expect(done.pens).toEqual(home ? [you, 3] : [3, you]);
      expect(done.winner === s.club.id).toBe(you > 3);
      expect(out.note).toContain(`${you}–3 on penalties`);
    }
  });

  test('without a live shootout the old seeded roll still settles it', () => {
    const s = newGame(31);
    const cup = startCup(s);
    recordCupMatch(s, 0, 0, [], sim);
    const t = cup.rounds[0].find((x) => x.a === s.club.id || x.b === s.club.id)!;
    expect(t.pens).toBeDefined();
    expect(t.winner).toBeDefined();
  });

  test('a live shootout score is ignored when the match was not drawn', () => {
    const s = newGame(31);
    const cup = startCup(s);
    recordCupMatch(s, 2, 0, [], sim, false, { you: 0, opp: 5 });
    const t = cup.rounds[0].find((x) => x.a === s.club.id || x.b === s.club.id)!;
    expect(t.pens).toBeUndefined();
    expect(t.winner).toBe(s.club.id);
  });
});
