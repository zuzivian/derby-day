// Free kicks (Law 13) the human can take properly: a wall formed 9.15 m off before the kick is
// ready, which stands still and jumps as it is struck; a strike that clears it and dips (with
// curl from a sideways drag); too much pace sails over; a quick free kick before the wall is set.
// Each scene is played from a realistic stoppage: both sides gathered round the ball first.

import { describe, expect, test } from 'bun:test';
import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { decodeReplay, encodeReplay, ReplayRecorder, REPLAY_VERSION } from '../src/meta/replay.ts';
import { wallSize } from '../src/sim/ai.ts';
import { GOAL_BAR_H, GOAL_W, PITCH_H, PITCH_W, RETREAT, SIM_VERSION } from '../src/sim/constants.ts';
import { oppGoal } from '../src/sim/field.ts';
import { createMatch, step } from '../src/sim/match.ts';
import { awardRestart } from '../src/sim/rules.ts';
import type { HumanInput, MatchState } from '../src/sim/types.ts';
import { dist, type Vec } from '../src/sim/vec.ts';
import { kickOff } from './helpers.ts';

const MID = PITCH_H / 2;

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  return { home: { ...cpuTeam(a, ladderSquad(a)), formation: '4-4-2' as const }, away: { ...cpuTeam(b, ladderSquad(b)), formation: '4-4-2' as const } };
}

const still = (s: MatchState): HumanInput => ({ cursor: { ...s.players[s.controlled[0]].pos } });

/**
 * A free kick to the human side (attacking x = 105 in the first half) `d` metres from goal, `off` metres
 * to the side, after both sides have gathered round the ball as they would at a real stoppage. Returns
 * at the first tick the kick can be taken (`ready`), unless `upTo` stops it at the start of set-up.
 */
function freeKick(seed: number, d: number, off = 0, direct = true, upTo: 'ready' | 'setup' = 'ready'): MatchState {
  const s = createMatch({ seed, ...teams(7 + (seed % 3) * 2), halfSeconds: 900, humanTeam: 0 });
  kickOff(s);
  const g = oppGoal(s, 0);
  const spot = { x: g.x - Math.sqrt(d * d - off * off), y: MID + off };
  const dx = 0.85 * (spot.x - PITCH_W / 2);
  for (const p of s.players) {
    if (p.role === 'GK') continue;
    p.pos = { x: Math.min(103, Math.max(2, PITCH_W / 2 + (p.pos.x - PITCH_W / 2) * 0.5 + dx)), y: p.pos.y };
    p.vel = { x: 0, y: 0 };
  }
  Object.assign(s.ball, { owner: -1, receiver: -1, inHands: false, pos: { ...spot }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  s.ball.noPickup.fill(160);
  for (let t = 0; t < 150; t++) step(s, still(s));
  awardRestart(s, 'freekick', 0, spot, 'foul', direct);
  for (let n = 0; n < 800 && s.restart && s.restart.stage !== upTo; n++) step(s, still(s));
  return s;
}

/** Play the human's kick and follow it: where it crossed the wall's line and the goal line, who touched it first, a goal. */
function strike(s: MatchState, input: HumanInput, ticks = 240) {
  const spot = { ...s.restart!.spot };
  const wall = [...(s.wall?.players ?? [])];
  const wallD = wall.length ? wall.reduce((a, i) => a + dist(s.players[i].pos, spot), 0) / wall.length : RETREAT;
  const taker = s.controlled[0];
  const goals = s.score[0];
  step(s, input);
  let zAtWall = -1;
  let first = -1;
  let line: { y: number; z: number } | null = null;
  const path: Vec[] = [];
  for (let t = 0; t < ticks && s.phase === 'play'; t++) {
    if (zAtWall < 0 && dist(s.ball.pos, spot) >= wallD) zAtWall = s.ball.z;
    if (first < 0 && s.ball.lastTouch !== taker && s.ball.lastTouch >= 0) first = s.ball.lastTouch;
    const prevX = s.ball.pos.x;
    path.push({ ...s.ball.pos });
    step(s, still(s));
    if (!line && prevX < PITCH_W && s.ball.pos.x >= PITCH_W) line = { y: s.ball.pos.y, z: s.ball.z };
  }
  const goal = s.score[0] > goals;
  return { zAtWall, first, wall, goal, line, path, over: !goal && first < 0 && !!line && line.z > GOAL_BAR_H };
}

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
const nearTop = (s: MatchState): Vec => ({ x: oppGoal(s, 0).x, y: MID + (s.restart!.spot.y >= MID ? 1 : -1) * (GOAL_W / 2 - 0.5) });
const farTop = (s: MatchState): Vec => ({ x: oppGoal(s, 0).x, y: MID - (s.restart!.spot.y >= MID ? 1 : -1) * (GOAL_W / 2 - 0.5) });

describe('the wall (Law 13)', () => {
  test('is formed 9.15 m off, from 18 to 31 m, before the kick is ready, and stands still', () => {
    let formed = 0;
    let scenes = 0;
    for (const d of [18, 22, 25, 31]) {
      for (const seed of [1, 2, 3, 4]) {
        const s = freeKick(seed, d);
        const w = s.wall!;
        scenes++;
        expect(w.players.length).toBe(wallSize(d));
        const spot = s.restart!.spot;
        for (const i of w.players) expect(dist(s.players[i].pos, spot)).toBeGreaterThanOrEqual(RETREAT - 0.01);
        // Every man on his mark (a man sent the long way round may still be on his way when the kick is ready, the
        // set-up having its limit): about 9.3 m off and shoulder to shoulder, no gap a ball goes through.
        const marks = s.aiRestart!.targets;
        if (w.players.every((i) => dist(s.players[i].pos, marks[i]!) < 0.3)) formed++;
        else continue;
        for (const i of w.players) expect(dist(s.players[i].pos, spot)).toBeLessThan(RETREAT + 0.9);
        const order = [...w.players].sort((a, b) => s.players[a].pos.y - s.players[b].pos.y);
        for (let k = 1; k < order.length; k++) expect(dist(s.players[order[k]].pos, s.players[order[k - 1]].pos)).toBeLessThan(1.25);
        const before = w.players.map((i) => ({ ...s.players[i].pos }));
        for (let t = 0; t < 45; t++) step(s, still(s));
        w.players.forEach((i, k) => expect(dist(s.players[i].pos, before[k])).toBeLessThan(0.05));
      }
    }
    // On main the wall men were still 10.2-10.4 m off at the ready tick, and there was no wall at all from 30 m.
    expect(formed).toBeGreaterThanOrEqual(scenes - 1);
  });

  test('an indirect free kick in shooting range gets one too', () => {
    const s = freeKick(2, 20, 0, false);
    expect(s.restart!.direct).toBe(false);
    expect(s.wall!.players.length).toBe(wallSize(20));
  });

  test('jumps together as it is struck, without moving, and lands', () => {
    const s = freeKick(3, 22);
    const w = s.wall!.players;
    const at = w.map((i) => ({ ...s.players[i].pos }));
    step(s, { ...still(s), cursor: nearTop(s), aim: nearTop(s), shoot: 0.6 });
    let peak = 0;
    for (let t = 0; t < 24; t++) {
      step(s, still(s));
      peak = Math.max(peak, ...w.map((i) => s.players[i].air ?? 0));
    }
    expect(peak).toBeGreaterThan(0.35);
    w.forEach((i, k) => expect(dist(s.players[i].pos, at[k])).toBeLessThan(0.05));
    for (let t = 0; t < 30; t++) step(s, still(s));
    expect(w.every((i) => (s.players[i].air ?? 0) === 0)).toBe(true);
    expect(s.wall ?? null).toBeNull();
  });

  test('a ball driven low goes under a man in the air, and hits a man on the ground', () => {
    const run = (jumping: boolean) => {
      const s = freeKick(4, 22);
      const i = s.wall!.players[0];
      const man = s.players[i];
      // Mid-jump (feet at the top of it), or the jump long over.
      s.wall!.struck = jumping ? s.tick - 18 : s.tick - 1000;
      s.phase = 'play';
      s.restart = null;
      for (const p of s.players) if (p.i !== i) p.pos = { x: p.pos.x, y: p.pos.y + (p.team === 1 && p.role !== 'GK' ? 30 : 0) };
      const b = s.ball;
      Object.assign(b, { owner: -1, pos: { x: man.pos.x - 3, y: man.pos.y }, vel: { x: 22, y: 0 }, z: 0.12, vz: 0, lastTouch: s.controlled[0], kickedBy: -1, receiver: -1 });
      b.noPickup.fill(0);
      for (let t = 0; t < 12; t++) step(s, still(s));
      return b.lastTouch === i;
    };
    expect(run(true)).toBe(false);
    expect(run(false)).toBe(true);
  });
});

describe("the human's free kick", () => {
  test('a quick click from 22 m clears the wall and dips in: about a goal in ten at the near post, almost never into the wall', () => {
    let clear = 0;
    let wallHit = 0;
    let goals = 0;
    for (const seed of SEEDS) {
      const s = freeKick(seed, 22);
      const r = strike(s, { ...still(s), cursor: nearTop(s), aim: nearTop(s), shoot: 0.55 });
      if (r.zAtWall > 2.5) clear++;
      if (r.first >= 0 && r.wall.includes(r.first)) wallHit++;
      if (r.goal) goals++;
    }
    // On main the same click stayed under 1.2 m at the wall: 0 of 30 cleared it, and 5.7% of shots from here were goals.
    expect(clear).toBeGreaterThanOrEqual(27);
    expect(wallHit).toBeLessThanOrEqual(2);
    expect(goals).toBeGreaterThanOrEqual(1);
    expect(goals).toBeLessThanOrEqual(10);
  });

  test('too much pace and it sails over the bar; a softer strike rarely does', () => {
    let overHard = 0;
    let overSoft = 0;
    for (const seed of SEEDS) {
      const s = freeKick(seed, 22);
      const s2 = structuredClone(s);
      if (strike(s, { ...still(s), cursor: nearTop(s), aim: nearTop(s), shoot: 1 }).over) overHard++;
      if (strike(s2, { ...still(s2), cursor: nearTop(s2), aim: nearTop(s2), shoot: 0.55 }).over) overSoft++;
    }
    expect(overHard).toBeGreaterThanOrEqual(20);
    expect(overSoft).toBeLessThanOrEqual(8);
  });

  test('curl bends it: out past the far post and back in, to where it was aimed; and beats the keeper there', () => {
    let bow = 0;
    let miss = 0;
    let n = 0;
    let goalsCurled = 0;
    let goalsStraight = 0;
    for (const seed of SEEDS) {
      const s = freeKick(seed, 25);
      const s2 = structuredClone(s);
      const aim = farTop(s);
      const spot = s.restart!.spot;
      // Bent toward the middle of the goal: the curl's left-hand normal points back across it.
      const curl = Math.sign(aim.x - spot.x) * Math.sign(MID - aim.y);
      const r = strike(s, { ...still(s), cursor: aim, aim, shoot: 0.55, curl });
      if (r.goal) goalsCurled++;
      if (strike(s2, { ...still(s2), cursor: aim, aim, shoot: 0.55 }).goal) goalsStraight++;
      if (!r.line) continue;
      n++;
      // Furthest the path strays from the straight line spot -> aim, on the far side.
      const ux = (aim.x - spot.x) / dist(aim, spot);
      const uy = (aim.y - spot.y) / dist(aim, spot);
      bow += Math.max(...r.path.map((p) => -((p.x - spot.x) * -uy + (p.y - spot.y) * ux) * curl));
      miss += Math.abs(r.line.y - aim.y);
    }
    expect(n).toBeGreaterThan(12);
    expect(bow / n).toBeGreaterThan(1);
    expect(miss / n).toBeLessThan(1.2);
    expect(goalsCurled).toBeGreaterThan(goalsStraight + 3);
  });

  test('a quick free kick: over the ball before the wall is set, a click plays it at once', () => {
    let quick = 0;
    let unformed = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const s = freeKick(seed, 24, 0, true, 'setup');
      const r = s.restart!;
      const taker = s.players[r.taker];
      // Walk him to the ball first.
      for (let t = 0; t < 200 && s.restart?.stage === 'setup' && dist(taker.pos, r.spot) > 1.2; t++) step(s, still(s));
      if (s.restart?.stage !== 'setup') continue;
      const mate = s.players.filter((p) => p.team === 0 && p.i !== taker.i && p.role !== 'GK').sort((a, b) => dist(a.pos, taker.pos) - dist(b.pos, taker.pos))[0];
      // Only a kick taken before the wall is set is a quick one.
      if (s.wall!.players.every((i) => dist(s.players[i].pos, s.aiRestart!.targets[i]!) < 0.3)) continue;
      unformed++;
      step(s, { cursor: { ...mate.pos }, aim: { ...mate.pos }, pass: true, moved: true });
      // Played there and then, and the wall breaks up.
      if (s.phase === 'play' && s.ball.owner !== taker.i && s.ball.lastTouch === taker.i && !s.wall) quick++;
    }
    // On main the click was held until the kick was ready (about 1.5 s later).
    expect(unformed).toBeGreaterThanOrEqual(5);
    expect(quick).toBe(unformed);
  });
});

describe('CPU free kicks', () => {
  test('go over the wall at about the same rate the human gets, and not over the bar most of the time', () => {
    let over = 0;
    let wallHit = 0;
    let n = 0;
    for (const seed of SEEDS) {
      const s = freeKick(seed, 22);
      // Hand the kick to the CPU: the human takes no part.
      s.humans = [false, false];
      const taker = s.restart!.taker;
      const goals = s.score[0];
      const wall = [...(s.wall?.players ?? [])];
      let first = -1;
      let shot = false;
      let lineZ = -1;
      for (let t = 0; t < 400; t++) {
        step(s);
        if (s.ball.setPiece === 'freekick' && s.stats[0].shots > 0) shot = true;
        if (s.phase === 'play' && first < 0 && s.ball.lastTouch !== taker && s.ball.lastTouch >= 0) first = s.ball.lastTouch;
        if (lineZ < 0 && s.ball.pos.x >= PITCH_W) lineZ = s.ball.z;
        if (s.score[0] > goals || (t > 60 && s.phase !== 'play')) break;
      }
      if (!shot) continue;
      n++;
      if (first < 0 && lineZ > GOAL_BAR_H) over++;
      if (first >= 0 && wall.includes(first)) wallHit++;
    }
    expect(n).toBeGreaterThan(10);
    expect(over / n).toBeLessThan(0.35);
    expect(wallHit / n).toBeLessThan(0.15);
  });
});

describe('replays carry the bend', () => {
  test('curl round-trips through a replay code (format 7)', () => {
    const [a, b] = generateLadder(11, 2);
    const home = cpuTeam(a, ladderSquad(a));
    const away = cpuTeam(b, ladderSquad(b));
    const rec = new ReplayRecorder({ seed: 2, home, away, halfSeconds: 4, humanTeam: 0 }, 'x');
    const s = createMatch({ seed: 2, home, away, halfSeconds: 4, humanTeam: 0 });
    for (let t = 0; s.phase !== 'fulltime'; t++) step(s, rec.push(t === 90 ? { cursor: { x: 60, y: 30 }, aim: { x: 100, y: 34 }, shoot: 0.6, curl: -0.37 } : {}));
    const r = decodeReplay(encodeReplay(rec.finish(s, 0)));
    expect(REPLAY_VERSION).toBe(7);
    expect(r.runs.some((x) => x.input.curl === -0.37 && x.input.shoot === 0.6)).toBe(true);
  });

  test('a format-6 code recorded on main (SIM_VERSION 7) still opens, flagged as from another sim version', () => {
    const V6 =
      'DD1.BgagHwEHClNlbG5lc3MgSUYDU05TAQ50kAH95oqwCQALCDEwN3g3YmQxCkouIEhhZXNlb2sBAMwIsAS0C9AF-AqACoAKB2gyNTYxajYNVC4gVGhvcm53b3J0aAMB6AyoBeAI4AjgCJwJwAIHenpkYjlzMwlILiBBbGRkZW4CAeAI4AOkCOQFoAuQCMgBCDFzM3ZyOXg0CVQuIE1hcnRvbgUBsAmUBcgGkAjsCZgM3AEIMWN1OGMyazUMQS4gQnJvb2t3ZWxsBAHsCbQG1AecCYAKuAgUB3hqcm1qcDkLQi4gUGVtd29ydGgIAsgLpAiMC9gJ_AfECZwECDE1cWZjZzI4C0EuIE11c2JhcmFuDwGICZgHsAn4CowLwAz8AggxcnY5M2w4YQpPLiBGZW5tb3JlCgK8CvQIgArgCPwHqArcAQd0eGV1bW5iCUouIEtpcmtieQcChAfIBpQK4AjAB4QMxAQHdGIwbzVjZglULiBEb2JpYWsJA-wJnAn8B_gKqAXECfABCDFxdjY4dDBjDEsuIEJyb29rd2VsbA4C5ArkCqgKpAjQBeAIyAERSGFsZGdyb3ZlIE9seW1waWMDSEdFAR0_jwH___-2BwYLB2IzMjZ2dGoKSC4gV29sYm9uZwEAjAbMA-QKuAjcBqAL7AkIMWlhaTZndG4JUy4gRG9zZW9rBAHECeQFkAisB9AKsAl4CDF3ZnJvcGtvCk0uIEtheW9taW4DAYgJ0AXECcwIxAnQCvABB3dwaGlxbXEKSi4gSGFlYm9uZw8BpAigBvAGpAjIC_QI8AEHNjZqMDJwbQpILiBDaHVib25nBQH8B6QD2ASgBtwL4AjMAwdreG80ODJsCU0uIEJvaHl1bgIBmAfkBfwHrAeACvQIKAgxcHd5a3lpdwhTLiBXb2xqdRECrAeMBowLvAq0BqgKoAEIMTM4a2MwbXMIWS4gV29sanUKAvQIrAe0C-AIiAnwBuADB3h0c2o0M3UKSi4gWWVvaHl1bg4C9AioCuAInAmMBvALyAEIMWZ4dTQwOXgJUy4gT2Jpb3JlCQPIBqgKtAb0CCjUB8gBB3U3Nzl2enkNTS4gU2luYW5naHl1bgsD6AecCfgF4AjMA9AFFAJ2NgAAAADvcZIhmwgVGQBAPBxAAlJGOMwCjce5LvKNcRRCS71sQAA2BNZJ';
    const r = decodeReplay(V6);
    expect(r.sim).toBe(7);
    expect(r.sim).not.toBe(SIM_VERSION);
    expect(r.ticks).toBeGreaterThan(0);
    expect(r.runs.some((x) => x.input.tactic === 2)).toBe(true);
    expect(r.runs.some((x) => x.input.shoot === 0.7 && x.input.curl === undefined)).toBe(true);
  });
});
