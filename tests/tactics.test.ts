// Formations and mentality: the data, the save and replay plumbing, CPU clubs'
// choices, and (on fixed seeds) that each mentality changes how a side plays
// in the direction its name promises. scripts/tactics-probe.ts prints the
// same measurements over many matches.

import { beforeAll, describe, expect, test } from 'bun:test';
import { autoLineup, clubFormation, clubMentality, cpuTeam, generateLadder, generateSquad, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { ensureElevenASide, newGame, setFormation, setMentality, clubTeam } from '../src/meta/game.ts';
import { decodeReplay, encodeReplay, type Replay } from '../src/meta/replay.ts';
import { averageMetrics, measureMatch, type TeamMetrics } from '../src/meta/tacticsProbe.ts';
import { FORMATION_IDS, FORMATIONS, MENTALITY_IDS, SIM_VERSION, TEAM_SIZE, type FormationId, type Mentality } from '../src/sim/constants.ts';
import { TACTICS } from '../src/sim/ai.ts';
import { makeRng } from '../src/sim/rng.ts';

describe('formations', () => {
  test('nine shapes, each a keeper and ten outfielders in slot order, on the pitch', () => {
    expect(FORMATION_IDS).toEqual(['4-4-2', '4-3-3', '4-2-3-1', '4-1-4-1', '4-4-1-1', '3-5-2', '3-4-3', '5-3-2', '5-4-1']);
    const order = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
    for (const id of FORMATION_IDS) {
      const f = FORMATIONS[id];
      expect(f.length).toBe(TEAM_SIZE);
      expect(f[0].role).toBe('GK');
      expect(f.filter((s) => s.role === 'GK').length).toBe(1);
      // The name's numbers add up to ten outfielders.
      expect(id.split('-').reduce((t, n) => t + Number(n), 0)).toBe(10);
      for (let i = 1; i < f.length; i++) expect(order[f[i].role]).toBeGreaterThanOrEqual(order[f[i - 1].role]);
      for (const s of f) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThan(0.7);
        expect(s.y).toBeGreaterThan(0);
        expect(s.y).toBeLessThan(1);
      }
      // Left-right balanced: the slots mirror about the middle.
      const ys = f.map((s) => s.y);
      expect(ys.reduce((t, y) => t + y, 0) / ys.length).toBeCloseTo(0.5, 5);
    }
  });

  test('back threes and fives have wing-backs, back fours full-backs; the sub-roles match the name', () => {
    const subs = (id: FormationId) => FORMATIONS[id].map((s) => s.sub);
    const count = (id: FormationId, sub: string) => subs(id).filter((s) => s === sub).length;
    for (const id of ['3-5-2', '3-4-3', '5-3-2', '5-4-1'] as FormationId[]) {
      expect(count(id, 'CB')).toBe(3);
      expect(count(id, 'WB')).toBe(2);
      expect(count(id, 'FB')).toBe(0);
    }
    for (const id of ['4-4-2', '4-3-3', '4-2-3-1', '4-1-4-1', '4-4-1-1'] as FormationId[]) {
      expect(count(id, 'CB')).toBe(2);
      expect(count(id, 'FB')).toBe(2);
    }
    expect(count('4-2-3-1', 'DM')).toBe(2);
    expect(count('4-2-3-1', 'AM')).toBe(1);
    expect(count('4-3-3', 'W')).toBe(2);
    expect(count('4-4-1-1', 'AM')).toBe(1);
    expect(count('5-4-1', 'ST')).toBe(1);
    expect(count('3-5-2', 'ST')).toBe(2);
    // Wing-backs in a back five start deeper than in a 3-5-2.
    const wbX = (id: FormationId) => FORMATIONS[id].find((s) => s.sub === 'WB')!.x;
    expect(wbX('5-3-2')).toBeLessThan(wbX('3-5-2'));
  });

  test('every formation plays a full match without errors', () => {
    const squad = generateSquad(makeRng(3), 60);
    const id = { id: 'x', name: 'X', short: 'X', primary: '#c00', secondary: '#fff', crest: 'plain' as const };
    for (const f of FORMATION_IDS) {
      const A = toTeamSetup(id, squad, autoLineup(squad, f), 0.6, f);
      const B = toTeamSetup({ ...id, primary: '#00c' }, squad, autoLineup(squad, '4-4-2'), 0.6, '4-4-2');
      const { state } = measureMatch({ seed: 11, home: A, away: B, halfSeconds: 20 });
      expect(state.phase).toBe('fulltime');
      expect(state.teams[0].formation).toBe(f);
    }
  });
});

describe('mentality in the save', () => {
  test('a new club plays Balanced 4-4-2; setMentality takes only the five steps', () => {
    const s = newGame(7);
    expect(s.formation).toBe('4-4-2');
    expect(s.mentality).toBe('balanced');
    setMentality(s, 'press');
    expect(s.mentality).toBe('press');
    setMentality(s, 'gegenpress' as Mentality);
    expect(s.mentality).toBe('press');
    expect(clubTeam(s, 0.6).mentality).toBe('press');
    // Balanced is left off the TeamSetup, so its replays match ones from before mentalities.
    setMentality(s, 'balanced');
    expect('mentality' in clubTeam(s, 0.6)).toBe(false);
  });

  test('older saves get Balanced; a formation this build lacks becomes 4-4-2 with a fresh XI', () => {
    const s = newGame(8);
    delete s.mentality;
    setFormation(s, '4-3-3');
    const lineup = [...s.lineup];
    ensureElevenASide(s);
    expect(s.mentality).toBe('balanced');
    expect(s.formation).toBe('4-3-3');
    expect(s.lineup).toEqual(lineup);

    const t = newGame(9);
    (t as { formation: string }).formation = '2-3-5';
    (t as { mentality: string }).mentality = 'gung-ho';
    ensureElevenASide(t);
    expect(t.formation).toBe('4-4-2');
    expect(t.mentality).toBe('balanced');
    expect(new Set(t.lineup).size).toBe(TEAM_SIZE);
    expect(t.lineup).toEqual(autoLineup(t.squad, '4-4-2'));
  });

  test('replays keep each side\'s formation and mentality', () => {
    const [a, b] = generateLadder(5, 2);
    const home = { ...cpuTeam(a, ladderSquad(a)), formation: '3-5-2' as FormationId, mentality: 'park' as Mentality };
    const away = { ...cpuTeam(b, ladderSquad(b)), formation: '4-2-3-1' as FormationId, mentality: 'press' as Mentality };
    const replay: Replay = { seed: 4, halfSeconds: 10, humanTeam: 0, home, away, ticks: 0, runs: [], goals: [], score: [0, 0], fp: 0, sim: SIM_VERSION, label: 'x', at: 0 } as Replay;
    const back = decodeReplay(encodeReplay(replay));
    expect(back.home.formation).toBe('3-5-2');
    expect(back.home.mentality).toBe('park');
    expect(back.away.formation).toBe('4-2-3-1');
    expect(back.away.mentality).toBe('press');
    for (const m of MENTALITY_IDS) {
      const r = decodeReplay(encodeReplay({ ...replay, home: { ...home, mentality: m } }));
      expect(r.home.mentality ?? 'balanced').toBe(m);
    }
  });
});

describe('CPU clubs', () => {
  test('each club has a fixed formation and mentality, and the ladder is varied', () => {
    const clubs = generateLadder(2026, 16);
    const fs = new Set(clubs.map(clubFormation));
    const ms = new Set(clubs.map(clubMentality));
    expect(fs.size).toBeGreaterThanOrEqual(5);
    expect(ms.size).toBeGreaterThanOrEqual(3);
    for (const c of clubs) {
      expect(clubFormation(c)).toBe(clubFormation({ id: c.id }));
      const t = cpuTeam(c, ladderSquad(c));
      expect(t.formation).toBe(clubFormation(c));
      expect(t.mentality ?? 'balanced').toBe(clubMentality(c));
    }
    // A back five never presses high.
    for (let i = 0; i < 400; i++) {
      const c = { id: `club-${i}` };
      if (clubFormation(c) === '5-3-2' || clubFormation(c) === '5-4-1') expect(clubMentality(c)).not.toBe('press');
    }
  });
});

describe('mentality changes how a side plays (fixed seeds, equal squads, each vs Balanced)', () => {
  // Sixteen matches a mentality at 90 s a half: enough for these averages to settle, quick enough for every run.
  const N = 16;
  const HALF = 90;
  const id = (name: string, primary: string) => ({ id: name, name, short: name, primary, secondary: '#fff', crest: 'plain' as const });
  const metrics = new Map<Mentality, TeamMetrics>();
  const vsBalanced = (m: Mentality): TeamMetrics => metrics.get(m)!;
  beforeAll(() => {
    // Side A plays each mentality, side B Balanced, same squad and skill; A's metrics averaged, home and away.
    for (const m of MENTALITY_IDS) {
      const list: TeamMetrics[] = [];
      for (let i = 0; i < N; i++) {
        const squad = generateSquad(makeRng(5000 + Math.floor(i / 2)), 60);
        const A = toTeamSetup(id('A', '#c00'), squad, autoLineup(squad, '4-4-2'), 0.6, '4-4-2', m);
        const B = toTeamSetup(id('B', '#00c'), squad, autoLineup(squad, '4-4-2'), 0.6, '4-4-2', 'balanced');
        const aHome = i % 2 === 0;
        const { teams } = measureMatch({ seed: 7100 + i, home: aHome ? A : B, away: aHome ? B : A, halfSeconds: HALF });
        list.push(teams[aHome ? 0 : 1]);
      }
      metrics.set(m, averageMetrics(list));
    }
  }, 120_000);

  test('the defensive line climbs, and more players commit forward, step by step from Park the bus to High press', () => {
    const lines = MENTALITY_IDS.map((m) => vsBalanced(m).line);
    const forward = MENTALITY_IDS.map((m) => vsBalanced(m).forward);
    for (let i = 1; i < 3; i++) expect(forward[i]).toBeGreaterThan(forward[i - 1] + 0.3);
    expect(forward[4]).toBeGreaterThan(forward[2] + 0.3);
    for (let i = 1; i < lines.length; i++) expect(lines[i]).toBeGreaterThan(lines[i - 1] + 2);
    expect(lines[4] - lines[0]).toBeGreaterThan(12); // metres
  });

  // Only effects far larger than eight matches' noise are asserted here; goals for and
  // against, shots and fouls need hundreds of matches (scripts/tactics-probe.ts).
  test('Park the bus: narrower and more compact block, fewer players forward, ', () => {
    const park = vsBalanced('park');
    const bal = vsBalanced('balanced');
    expect(park.width).toBeLessThan(bal.width - 3);
    expect(park.forward).toBeLessThan(bal.forward - 1);
    expect(park.depth).toBeLessThan(bal.depth - 4);
  });

  test('High press: more men round the ball, wins it back higher, takes more risk on the ball', () => {
    const press = vsBalanced('press');
    const bal = vsBalanced('balanced');
    expect(press.pressers).toBeGreaterThan(bal.pressers + 0.1);
    expect(press.regainHeight).toBeGreaterThan(bal.regainHeight + 2);
    // Riskier passing: fewer reach a teammate.
    expect(press.passCompletion).toBeLessThan(bal.passCompletion);
    expect(vsBalanced('park').passCompletion).toBeGreaterThan(bal.passCompletion);
  });

  test('the knobs move one way from Park the bus to High press', () => {
    const t = MENTALITY_IDS.map((m) => TACTICS[m]);
    for (let i = 1; i < t.length; i++) {
      expect(t[i].lineMax).toBeGreaterThan(t[i - 1].lineMax);
      expect(t[i].attMax).toBeGreaterThan(t[i - 1].attMax);
      expect(t[i].risk).toBeGreaterThan(t[i - 1].risk);
      expect(t[i].tackle).toBeGreaterThan(t[i - 1].tackle);
      expect(t[i].extra + t[i].counterN).toBeGreaterThanOrEqual(t[i - 1].extra + t[i - 1].counterN);
      expect(t[i].boxRunners).toBeGreaterThanOrEqual(t[i - 1].boxRunners);
    }
    expect(TACTICS.park.pressUpTo).toBeLessThan(0.5);
    expect(TACTICS.press.counter).toBeGreaterThan(TACTICS.attacking.counter);
  });
});
