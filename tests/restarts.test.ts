// Throw-ins and goal kicks the human can use: a long throw lands where it was aimed (as far as his arms go) and
// is meant for the man nearest where it comes down; a throw led to where a marker stands goes to its man's feet
// instead; a short throw is kept; a goal kick held long lands where the button went down, the centre circle
// included.

import { describe, expect, test } from 'bun:test';
import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { PITCH_H, PITCH_W } from '../src/sim/constants.ts';
import { oppGoal, ownGoal } from '../src/sim/field.ts';
import { createMatch, step } from '../src/sim/match.ts';
import { awardRestart } from '../src/sim/rules.ts';
import type { HumanInput, MatchState, RestartKind } from '../src/sim/types.ts';
import { dist, type Vec } from '../src/sim/vec.ts';
import { kickOff } from './helpers.ts';

const MID = PITCH_H / 2;

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  return { home: { ...cpuTeam(a, ladderSquad(a)), formation: '4-4-2' as const }, away: { ...cpuTeam(b, ladderSquad(b)), formation: '4-4-2' as const } };
}

const still = (s: MatchState): HumanInput => ({ cursor: { ...s.players[s.controlled[0]].pos } });

/** A restart to the human side at `at`, after both sides have gathered near `around` (as play left them). Returns at the start of `stage`. */
function restart(seed: number, kind: RestartKind, at: Vec, around: Vec, stage: 'setup' | 'ready' = 'ready'): MatchState {
  const s = createMatch({ seed, ...teams(7 + (seed % 3) * 2), halfSeconds: 900, humanTeam: 0 });
  kickOff(s);
  const dx = 0.85 * (around.x - PITCH_W / 2);
  for (const p of s.players) {
    if (p.role === 'GK') continue;
    p.pos = { x: Math.min(103, Math.max(2, PITCH_W / 2 + (p.pos.x - PITCH_W / 2) * 0.5 + dx)), y: p.pos.y };
    p.vel = { x: 0, y: 0 };
  }
  Object.assign(s.ball, { owner: -1, receiver: -1, inHands: false, pos: { ...around }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  s.ball.noPickup.fill(130);
  for (let t = 0; t < 120; t++) step(s, still(s));
  awardRestart(s, kind, 0, at, 'out');
  for (let n = 0; n < 900 && s.restart && s.restart.stage !== stage; n++) step(s, still(s));
  return s;
}

/** Where a ball played now first comes down, everyone but the taker out of the way. */
function landing(s: MatchState, input: HumanInput): Vec {
  for (const p of s.players)
    if (p.i !== s.restart!.taker) {
      p.pos = { x: 20 + p.i, y: 60 };
      p.stun = 1e7;
    }
  step(s, input);
  for (let t = 0; t < 400 && !(s.ball.z === 0 && t > 3); t++) step(s, still(s));
  return { ...s.ball.pos };
}

describe('throw-ins', () => {
  test('a long throw lands where it was aimed, and is meant for the man nearest where it comes down', () => {
    let worst = 0;
    let withReceiver = 0;
    let n = 0;
    for (const seed of [1, 2, 3, 4]) {
      const gx = 105;
      const at = { x: gx - 14, y: 0 };
      const s = restart(seed, 'throwin', at, { x: gx - 14, y: 8 });
      const aim = { x: gx - 9, y: MID - 12 }; // a long throw to the edge of the box, about 22 m
      const t = structuredClone(s);
      step(t, { cursor: aim, aim, loft: 0.6, moved: true });
      n++;
      if (t.ball.receiver >= 0 && t.players[t.ball.receiver].team === 0) withReceiver++;
      worst = Math.max(worst, dist(landing(s, { cursor: aim, aim, loft: 0.6, moved: true }), aim));
    }
    // On main a long throw had no receiver, and nobody went to meet it.
    expect(withReceiver).toBe(n);
    expect(worst).toBeLessThan(3);
  });

  test('aimed past his reach, it comes down at the end of his arms along that line', () => {
    const s = restart(1, 'throwin', { x: 91, y: 0 }, { x: 91, y: 8 });
    const r = s.restart!;
    const reach = 18 + 14 * s.players[r.taker].attrs.passing;
    const aim = { x: 96, y: MID - 6 };
    expect(dist(r.spot, aim)).toBeGreaterThan(reach + 2);
    const land = landing(s, { cursor: aim, aim, loft: 0.6, moved: true });
    expect(Math.abs(dist(land, r.spot) - reach)).toBeLessThan(2);
    // Along the line to the aim.
    const along = ((land.x - r.spot.x) * (aim.x - r.spot.x) + (land.y - r.spot.y) * (aim.y - r.spot.y)) / dist(aim, r.spot);
    expect(Math.sqrt(Math.max(0, dist(land, r.spot) ** 2 - along ** 2))).toBeLessThan(2);
  });

  test('led to where a marker is standing, it goes to the man\'s feet instead, and he has it', () => {
    let ours = 0;
    let n = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = restart(seed, 'throwin', { x: 55, y: 0 }, { x: 55, y: 8 });
      const r = s.restart!;
      const [mate] = s.players.filter((p) => p.team === 0 && p.i !== r.taker && p.role !== 'GK');
      const [opp] = s.players.filter((p) => p.team === 1 && p.role !== 'GK');
      for (const p of s.players)
        if (p.i !== r.taker && p !== mate && p !== opp) {
          p.pos = { x: 20 + p.i, y: 60 };
          p.stun = 1e7;
        }
      // Our man 11 m in, jogging up the line; theirs standing a few metres ahead of him, where the throw leads him.
      mate.pos = { x: r.spot.x - 2, y: r.spot.y + 11 };
      mate.vel = { x: 4, y: 0 };
      opp.pos = { x: r.spot.x + 2.5, y: r.spot.y + 11 };
      opp.vel = { x: 0, y: 0 };
      step(s, { cursor: { ...mate.pos }, aim: { ...mate.pos }, pass: true, moved: true });
      n++;
      for (let t = 0; t < 150; t++) {
        const lt = s.ball.lastTouch;
        if (lt >= 0 && lt !== r.taker) {
          if (lt === mate.i) ours++;
          break;
        }
        step(s, still(s));
      }
    }
    // On main it was led onto the marker, who took it.
    expect(ours).toBeGreaterThanOrEqual(n - 1);
  });

  test('a short throw to the nearest man is kept more often than not', () => {
    let kept = 0;
    let n = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const at = { x: 50 + (seed % 7) * 3, y: seed % 2 ? 0 : PITCH_H };
      const s = restart(seed, 'throwin', at, { x: at.x, y: at.y ? PITCH_H - 8 : 8 });
      const r = s.restart!;
      const mate = s.players.filter((p) => p.team === 0 && p.i !== r.taker && p.role !== 'GK').sort((a, b) => dist(a.pos, r.spot) - dist(b.pos, r.spot))[0];
      step(s, { cursor: { ...mate.pos }, aim: { ...mate.pos }, pass: true, moved: true });
      for (let t = 0; t < 150; t++) {
        const lt = s.ball.lastTouch;
        if (lt >= 0 && lt !== r.taker) {
          n++;
          if (s.players[lt].team === 0) kept++;
          break;
        }
        step(s, still(s));
      }
    }
    expect(n).toBeGreaterThan(80);
    // About 65 of 100 here (it was 16 of 20 before main's pressing changes in #28): a marker standing where the throw
    // was led to takes it. The throw to his feet keeps more. 20 seeds moved by two throws whenever anything in the sim
    // changed (stamina, say), so the sample is 100 and the bar a little under the rate.
    expect(kept / n).toBeGreaterThan(0.55);
  });
});

describe('goal kicks', () => {
  test('held long, it lands where the button went down: the centre circle, or out to a wing', () => {
    let worst = 0;
    for (const seed of [1, 2, 3]) {
      for (const aimAt of [{ x: 52.5, y: MID }, { x: 40, y: 8 }]) {
        const s = restart(seed, 'goalkick', { x: -1, y: MID - 6 }, { x: 10, y: MID - 6 });
        const keeperSide = ownGoal(s, 0).x;
        expect(keeperSide).toBe(0);
        worst = Math.max(worst, dist(landing(s, { cursor: aimAt, aim: aimAt, loft: 0.7, moved: true }), aimAt));
      }
    }
    // On main a held goal kick to the centre circle came down 10-22 m short of it (the open-play loft's 40 m range).
    expect(worst).toBeLessThan(3);
    // The other way round it is the same (oppGoal is the end it is kicked toward).
    expect(oppGoal(restart(1, 'goalkick', { x: -1, y: MID }, { x: 10, y: MID }), 0).x).toBe(PITCH_W);
  });
});
