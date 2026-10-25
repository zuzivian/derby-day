// Final-third attacking play (src/sim/ai.ts attackRun, boxZone, the carrier's shot choice):
// scenes for the decisions, and fixed-seed matches for the rates. scripts/attack-probe.ts
// prints the same measurements over many matches, scripts/balance.ts --assert the totals.

import { beforeAll, describe, expect, test } from 'bun:test';
import { addAttack, AttackObserver, emptyAttack, measureAttack, scriptedRunnerHuman, shotXg, type AttackTally } from '../src/meta/attackProbe.ts';
import { autoLineup, cpuTeam, generateLadder, generateSquad, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { aiIntent, bestPassOption, TACTICS } from '../src/sim/ai.ts';
import { MENTALITY_IDS, type Mentality } from '../src/sim/constants.ts';
import { inOffsidePosition, secondLastOpponentX, teamX } from '../src/sim/field.ts';
import { createMatch, step } from '../src/sim/match.ts';
import { makeRng } from '../src/sim/rng.ts';
import type { MatchPlayer, MatchState } from '../src/sim/types.ts';
import type { Vec } from '../src/sim/vec.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  return { home: cpuTeam(a, ladderSquad(a)), away: cpuTeam(b, ladderSquad(b)) };
}

/** A CPU-vs-CPU match in open play, with only the named players left on the pitch (the rest sent off). */
function scene(keep: (s: MatchState) => MatchPlayer[]): MatchState {
  const s = createMatch({ seed: 3, ...teams(4), halfSeconds: 60, humans: [false, false] });
  while (s.phase !== 'play') step(s);
  const kept = keep(s);
  for (const p of s.players) {
    if (kept.includes(p)) continue;
    p.sentOff = true;
    p.pos = { x: 52, y: -3 };
    p.vel = { x: 0, y: 0 };
  }
  for (const p of kept) {
    p.vel = { x: 0, y: 0 };
    p.stun = 0;
  }
  s.aiPlans = [null, null];
  return s;
}
const pick = (s: MatchState, team: 0 | 1, role: string, k = 0) => s.players.filter((p) => p.team === team && (p.role === role || p.sub === role))[k];
function give(s: MatchState, p: MatchPlayer, at: Vec): void {
  p.pos = { ...at };
  p.facing = { x: p.team === 0 ? 1 : -1, y: 0 };
  s.ball.owner = p.i;
  s.ball.pos = { x: at.x + (p.team === 0 ? 0.9 : -0.9), y: at.y };
  s.ball.vel = { x: 0, y: 0 };
  s.ball.z = 0;
  s.ball.vz = 0;
}

describe('the carrier weighs the final-third options', () => {
  test('a run in behind is a real option: the passer plays it on the ground into the space ahead of the runner', () => {
    const s = scene((s) => [pick(s, 0, 'MID'), pick(s, 0, 'FWD'), pick(s, 1, 'GK'), pick(s, 1, 'CB', 0), pick(s, 1, 'CB', 1)]);
    const [c, st, , cb1, cb2] = [pick(s, 0, 'MID'), pick(s, 0, 'FWD'), pick(s, 1, 'GK'), pick(s, 1, 'CB', 0), pick(s, 1, 'CB', 1)];
    give(s, c, { x: 52, y: 34 });
    cb1.pos = { x: 74, y: 28 };
    cb2.pos = { x: 74, y: 40 };
    // The striker is a stride onside, sprinting on a diagonal run into the channel.
    st.pos = { x: 72.5, y: 31 };
    st.vel = { x: 8, y: -1.5 };
    st.ai = { lastTick: s.tick, target: null, retarget: 0, attacking: true, mode: 'none', modeTicks: 0, modeTarget: null, run: { kind: 'behind', target: { x: 86, y: 26 }, until: s.tick + 60, carrier: c.i, go: true } };
    expect(inOffsidePosition(s, st)).toBe(false);
    const opt = bestPassOption(s, c, 0)!;
    expect(opt.receiver.i).toBe(st.i);
    expect(opt.lofted ?? false).toBe(false);
    // Into the space beyond the line, ahead of him and toward his run.
    expect(teamX(0, opt.target.x)).toBeGreaterThan(secondLastOpponentX(s, 0) + 0.03);
    expect(opt.target.y).toBeLessThan(st.pos.y);
  });

  test('from 22 m, closed down, with a teammate free 11 m out, he passes rather than shoots; free 12 m out himself, he shoots', () => {
    const s = scene((s) => [pick(s, 0, 'MID'), pick(s, 0, 'FWD'), pick(s, 1, 'GK'), pick(s, 1, 'CB', 0), pick(s, 1, 'CB', 1)]);
    const [c, st, gk, cb1, cb2] = [pick(s, 0, 'MID'), pick(s, 0, 'FWD'), pick(s, 1, 'GK'), pick(s, 1, 'CB', 0), pick(s, 1, 'CB', 1)];
    gk.pos = { x: 104, y: 34 };
    // One centre-back closes the shooter, the other is goal-side of the striker but has left him room.
    cb1.pos = { x: 86, y: 32 };
    cb2.pos = { x: 98.5, y: 31 };
    give(s, c, { x: 83, y: 34 });
    st.pos = { x: 96, y: 25 };
    let passes = 0;
    let shots = 0;
    for (let k = 0; k < 40; k++) {
      c.aiTimer = 0;
      const a = aiIntent(s, c).action;
      if (a?.kind === 'pass' || a?.kind === 'chip') passes++;
      if (a?.kind === 'shoot') shots++;
    }
    expect(passes).toBeGreaterThan(30);
    expect(shots).toBeLessThan(5);

    give(s, c, { x: 93, y: 34 });
    st.pos = { x: 70, y: 10 };
    cb1.pos = { x: 80, y: 20 };
    cb2.pos = { x: 80, y: 50 };
    shots = 0;
    for (let k = 0; k < 20; k++) {
      c.aiTimer = 0;
      if (aiIntent(s, c).action?.kind === 'shoot') shots++;
    }
    expect(shots).toBeGreaterThan(17);
  });

  test('at the byline with a teammate arriving at the spot, the winger cuts it back along the ground', () => {
    const s = scene((s) => [pick(s, 0, 'MID', 0), pick(s, 0, 'FWD'), pick(s, 1, 'GK'), pick(s, 1, 'CB', 0), pick(s, 1, 'CB', 1)]);
    const [w, st, gk, cb1, cb2] = [pick(s, 0, 'MID', 0), pick(s, 0, 'FWD'), pick(s, 1, 'GK'), pick(s, 1, 'CB', 0), pick(s, 1, 'CB', 1)];
    w.sub = 'W';
    gk.pos = { x: 104, y: 31 };
    // The defenders have been dragged back to the posts by the run to the byline.
    cb1.pos = { x: 102.5, y: 31 };
    cb2.pos = { x: 102.5, y: 36 };
    give(s, w, { x: 101, y: 16 });
    st.pos = { x: 93, y: 31 };
    let cut = 0;
    for (let k = 0; k < 20; k++) {
      w.aiTimer = 0;
      const a = aiIntent(s, w).action;
      if (a?.kind === 'pass' && a.receiver === st.i && a.target.x < w.pos.x) cut++;
    }
    expect(cut).toBeGreaterThan(15);
  });
});

describe('the attack probe', () => {
  test('xG of a shot: about 0.4 from 6 m central, 0.2 from the spot, 0.07 from the edge, 0.03 from 25 m, less from an angle', () => {
    expect(shotXg(0, { x: 99, y: 34 })).toBeGreaterThan(0.35);
    expect(shotXg(0, { x: 94, y: 34 })).toBeCloseTo(0.2, 1);
    expect(shotXg(0, { x: 87, y: 34 })).toBeGreaterThan(0.05);
    expect(shotXg(0, { x: 87, y: 34 })).toBeLessThan(0.1);
    expect(shotXg(0, { x: 80, y: 34 })).toBeLessThan(0.04);
    expect(shotXg(0, { x: 99, y: 16 })).toBeLessThan(shotXg(0, { x: 99, y: 30 }));
    expect(shotXg(1, { x: 6, y: 34 })).toBeCloseTo(shotXg(0, { x: 99, y: 34 }), 6);
  });

  test('counts the same as the sim: shots, goals and passes add up', () => {
    const { state, teams: t } = measureAttack({ seed: 9, ...teams(9), halfSeconds: 60 });
    for (const side of [0, 1] as const) {
      expect(t[side].shots.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(state.stats[side].shots);
      expect(t[side].goals).toBe(state.score[side]);
      expect(t[side].passes).toBe(state.stats[side].passes);
      expect(t[side].boxShots).toBeLessThanOrEqual(t[side].shots[0] + t[side].shots[1]);
    }
    expect(new AttackObserver().t[0].matches).toBe(0);
  });
});

describe('CPU sides create chances in the box (fixed seeds, the balance fixtures)', () => {
  const total = emptyAttack();
  const offsideRuns = { ticks: 0, offside: 0 };
  beforeAll(() => {
    const ladders = [2026, 2027, 2028].map((seed) => generateLadder(seed, 16));
    for (let i = 0; i < 24; i++) {
      const clubs = ladders[i % 3];
      const j = Math.floor(i / 3);
      const a = clubs[j % 16];
      const b = clubs[(j * 7 + 3) % 16];
      const s = createMatch({ seed: i, home: cpuTeam(a, ladderSquad(a)), away: cpuTeam(b, ladderSquad(b)), humans: [false, false] });
      const obs = new AttackObserver();
      while (s.phase !== 'fulltime') {
        step(s);
        obs.observe(s);
        // A runner whose ball hasn't been played (his carrier still has it) stays onside.
        if (s.phase !== 'play' || s.ball.owner < 0) continue;
        for (const p of s.players) {
          const r = p.ai?.run;
          if (!r || r.kind !== 'behind' || !r.go || r.carrier !== s.ball.owner) continue;
          offsideRuns.ticks++;
          if (inOffsidePosition(s, p)) offsideRuns.offside++;
        }
      }
      for (const t of obs.finish(s)) addAttack(total, t);
    }
  }, 120_000);

  const shots = () => total.shots.reduce((a, b) => a + b, 0);
  const perSide = (v: number) => v / total.matches;

  test('at least 35% of shots come from inside the box, and 35-55% from 18-30 m (main before: 17% and 64%)', () => {
    expect(total.boxShots / shots()).toBeGreaterThan(0.35);
    expect(total.shots[2] / shots()).toBeGreaterThan(0.35);
    expect(total.shots[2] / shots()).toBeLessThan(0.55);
    // From 30 m and beyond only now and then (main before: 23%).
    expect(total.shots[3] / shots()).toBeLessThan(0.06);
  });

  test('box entries well up on main (0.9 a side), through balls and crosses that find a teammate', () => {
    const e = total.entries;
    expect(perSide(e.carry + e.pass + e.cross + e.other)).toBeGreaterThan(1.3);
    expect(total.edgeToBox / total.edgeSpells).toBeGreaterThan(0.15);
    expect(perSide(total.throughAtt)).toBeGreaterThan(2);
    expect(total.crossCmp / total.crossAtt).toBeGreaterThan(0.15);
    expect(total.cutAtt).toBeGreaterThan(0);
  });

  test('runners in behind stay onside until the ball is played: under 3% of their ticks in an offside position', () => {
    expect(offsideRuns.ticks).toBeGreaterThan(1000);
    expect(offsideRuns.offside / offsideRuns.ticks).toBeLessThan(0.03);
  });
});

describe('mentality: how many commit to the attack (equal squads, each vs Balanced)', () => {
  const by = new Map<Mentality, AttackTally>();
  beforeAll(() => {
    const id = (name: string, primary: string) => ({ id: name, name, short: name, primary, secondary: '#fff', crest: 'plain' as const });
    for (const m of MENTALITY_IDS) {
      const t = emptyAttack();
      for (let i = 0; i < 8; i++) {
        const squad = generateSquad(makeRng(5000 + Math.floor(i / 2)), 60);
        const A = toTeamSetup(id('A', '#c00'), squad, autoLineup(squad, '4-4-2'), 0.6, '4-4-2', m);
        const B = toTeamSetup(id('B', '#00c'), squad, autoLineup(squad, '4-4-2'), 0.6, '4-4-2', 'balanced');
        const aHome = i % 2 === 0;
        const { teams: r } = measureAttack({ seed: 7300 + i, home: aHome ? A : B, away: aHome ? B : A, halfSeconds: 90 });
        addAttack(t, r[aHome ? 0 : 1]);
      }
      by.set(m, t);
    }
  }, 120_000);

  test('the knobs: more runners and more bodies in the box from Park the bus to High press', () => {
    const t = MENTALITY_IDS.map((m) => TACTICS[m]);
    for (let i = 1; i < t.length; i++) {
      expect(t[i].runners).toBeGreaterThanOrEqual(t[i - 1].runners);
      expect(t[i].boxBodies).toBeGreaterThanOrEqual(t[i - 1].boxBodies);
    }
    expect(TACTICS.park.runners + TACTICS.defensive.runners).toBeLessThanOrEqual(2);
    expect(TACTICS.press.runners).toBeGreaterThan(TACTICS.balanced.runners);
  });

  test('Attacking and High press make far more runs in behind than Park the bus and Defensive', () => {
    const runs = (m: Mentality) => by.get(m)!.runs / by.get(m)!.matches;
    expect(runs('attacking') + runs('press')).toBeGreaterThan(2 * (runs('park') + runs('defensive')));
    expect(runs('balanced')).toBeGreaterThan(runs('park'));
  });
});

describe('a scripted human who passes to the most advanced open runner', () => {
  test('his CPU teammates make runs in behind for him to pick out (full matches)', () => {
    const t = emptyAttack();
    for (let i = 0; i < 6; i++) {
      const { teams: r } = measureAttack({ seed: 60 + i, ...teams(20 + i), humanTeam: 0 }, scriptedRunnerHuman(0));
      addAttack(t, r[0]);
    }
    const e = t.entries;
    console.log(`scripted human, 6 matches: ${t.runs} runs in behind by his teammates, ${t.throughAtt} through balls, ${e.carry + e.pass + e.cross + e.other} box entries, ${t.boxShots} shots in the box`);
    // About 2 a match on main before this stream; 7-9 over 150 matches (scripts/attack-probe.ts --human).
    expect(t.runs / t.matches).toBeGreaterThan(3);
    expect(e.carry + e.pass + e.cross + e.other).toBeGreaterThan(0);
  }, 60_000);
});
