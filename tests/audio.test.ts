import { describe, expect, test } from 'bun:test';
import { crowdLevel, detectSfx, initialSnapshot, snapshot, type SfxEvent } from '../src/client/audio.ts';
import { generateLadder, autoLineup, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { GOAL_TOP, PITCH_H, PITCH_W } from '../src/sim/constants.ts';
import { createMatch, step } from '../src/sim/match.ts';
import type { MatchState } from '../src/sim/types.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

/** A match in live play with the ball loose and everybody parked out of the way. */
function liveMatch(): MatchState {
  const s = createMatch({ seed: 5, ...teams(7), halfSeconds: 30, humanTeam: -1 });
  s.phase = 'play';
  s.ball.owner = -1;
  s.ball.vel = { x: 0, y: 0 };
  s.players.forEach((p, i) => {
    p.pos = { x: 5 + (i % 6) * 2, y: 4 + Math.floor(i / 6) * 30 };
    p.tackleCd = 0;
  });
  return s;
}

type Kick = Extract<SfxEvent, { type: 'kick' }>;
const types = (evs: SfxEvent[]) => evs.map((e) => e.type);

describe('detectSfx', () => {
  test('quiet when nothing happens', () => {
    const s = liveMatch();
    s.ball.pos = { x: 30, y: 20 };
    expect(detectSfx(snapshot(s), s)).toEqual([]);
  });

  test('opening kick-off whistles once', () => {
    const s = createMatch({ seed: 5, ...teams(7), halfSeconds: 30, humanTeam: -1 });
    expect(detectSfx(initialSnapshot(s), s)).toEqual([{ type: 'whistle', kind: 'kickoff' }]);
    expect(detectSfx(snapshot(s), s)).toEqual([]);
  });

  test('a pass and a shot are told apart, and harder kicks have more power', () => {
    const s = liveMatch();
    const carrier = s.players[0];
    s.ball.owner = carrier.i;
    const before = snapshot(s);
    s.ball.owner = -1;
    s.ball.passFrom = carrier.i;
    s.ball.vel = { x: 10, y: 0 };
    expect(detectSfx(before, s)).toEqual([{ type: 'kick', kind: 'pass', power: expect.any(Number) }]);

    s.ball.passFrom = -1;
    s.ball.vel = { x: 28, y: 0 };
    const hard = detectSfx(before, s)[0] as Kick;
    expect(hard).toMatchObject({ type: 'kick', kind: 'shot' });
    s.ball.vel = { x: 14, y: 0 };
    const soft = detectSfx(before, s)[0] as Kick;
    expect(hard.power).toBeGreaterThan(soft.power);
  });

  test('picking the ball up is not a kick', () => {
    const s = liveMatch();
    s.ball.vel = { x: 8, y: 0 };
    const before = snapshot(s);
    s.ball.owner = 1;
    expect(detectSfx(before, s)).toEqual([]);
  });

  test('board knock on a wall bounce, with power from speed', () => {
    const s = liveMatch();
    s.ball.pos = { x: 30, y: 0.5 };
    s.ball.vel = { x: 3, y: -20 };
    const before = snapshot(s);
    s.ball.vel = { x: 3, y: 13 };
    const ev = detectSfx(before, s);
    expect(ev).toEqual([{ type: 'knock', kind: 'board', power: expect.any(Number) }]);
    expect((ev[0] as { power: number }).power).toBeGreaterThan(0.5);
  });

  test('a ball merely rolling along the boards does not knock', () => {
    const s = liveMatch();
    s.ball.pos = { x: 30, y: 0.5 };
    s.ball.vel = { x: 10, y: 0 };
    const before = snapshot(s);
    s.ball.pos = { x: 30.2, y: 0.5 };
    expect(detectSfx(before, s)).toEqual([]);
  });

  test('post knock is distinguished from boards', () => {
    const s = liveMatch();
    s.ball.pos = { x: 0.3, y: GOAL_TOP };
    s.ball.vel = { x: -12, y: 0 };
    const before = snapshot(s);
    s.ball.vel = { x: 12, y: 0 };
    expect(detectSfx(before, s)).toEqual([{ type: 'knock', kind: 'post', power: expect.any(Number) }]);
  });

  test('bounces inside the net are left to the goal sound', () => {
    const s = liveMatch();
    s.ball.pos = { x: PITCH_W + 1, y: PITCH_H / 2 };
    s.ball.vel = { x: 5, y: 0 };
    const before = snapshot(s);
    s.ball.vel = { x: -1, y: 0 };
    expect(detectSfx(before, s)).toEqual([]);
  });

  test('goal event when events grow, no whistle', () => {
    const s = liveMatch();
    const before = snapshot(s);
    s.goals.push({ kind: 'goal', tick: s.tick, minute: 3, second: 150, team: 1, player: -1, scorer: 'X', ownGoal: false, from: 'play' });
    s.phase = 'goal';
    expect(detectSfx(before, s)).toEqual([{ type: 'goal', team: 1 }]);
  });

  test('restart after a goal, half-time and full-time whistle', () => {
    const s = liveMatch();
    let prev = snapshot(s);
    s.phase = 'halftime';
    expect(detectSfx(prev, s)).toEqual([{ type: 'whistle', kind: 'halftime' }]);
    prev = snapshot(s);
    s.phase = 'kickoff';
    expect(detectSfx(prev, s)).toEqual([{ type: 'whistle', kind: 'kickoff' }]);
    prev = { ...snapshot(s), phase: 'play' };
    s.phase = 'fulltime';
    expect(detectSfx(prev, s)).toEqual([{ type: 'whistle', kind: 'fulltime' }]);
  });

  test('tackle lunge and won tackle', () => {
    const s = liveMatch();
    const before = snapshot(s);
    s.players[2].tackleCd = 36;
    expect(detectSfx(before, s)).toEqual([{ type: 'tackle', won: false }]);
    s.stats[0].tackles++;
    expect(detectSfx(before, s)).toEqual([{ type: 'tackle', won: true }]);
  });

  test('a won tackle that knocks the ball loose is a tackle, not a kick', () => {
    const s = liveMatch();
    s.ball.owner = 0;
    const before = snapshot(s);
    s.ball.owner = -1;
    s.ball.vel = { x: 6, y: 0 };
    s.stats[1].tackles++;
    expect(types(detectSfx(before, s))).toEqual(['tackle']);
  });
});

describe('detectSfx over a real match', () => {
  test('emits plausible, bounded events when stepping a CPU match', () => {
    const s = createMatch({ seed: 11, ...teams(3), halfSeconds: 40, humanTeam: -1 });
    let prev = initialSnapshot(s);
    const counts: Record<string, number> = {};
    while (s.phase !== 'fulltime') {
      step(s);
      for (const e of detectSfx(prev, s)) {
        const key = e.type === 'whistle' && e.kind === 'foul' ? 'foulWhistle' : e.type;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      prev = snapshot(s);
    }
    const total = s.score[0] + s.score[1];
    expect(counts.goal ?? 0).toBe(total);
    expect(counts.kick).toBeGreaterThan(10);
    // opening kick-off, a restart per goal, second half, half-time, full-time
    expect(counts.whistle).toBe(1 + total + 1 + 1 + 1);
    // and one short blast for every stoppage the referee called (fouls, offsides, advantage brought back)
    const called = s.events.filter((e) => e.kind === 'restart' && e.reason !== 'out' && e.restart !== 'kickoff').length;
    expect(counts.foulWhistle ?? 0).toBe(called);
    expect(counts.knock ?? 0).toBeLessThan(counts.kick * 2);
  });
});

describe('crowdLevel', () => {
  test('rises as the ball nears a goal and stays in range', () => {
    const s = liveMatch();
    s.ball.pos = { x: PITCH_W / 2, y: PITCH_H / 2 };
    const mid = crowdLevel(s);
    s.ball.pos = { x: PITCH_W - 4, y: PITCH_H / 2 };
    const box = crowdLevel(s);
    expect(box).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
    expect(box).toBeLessThanOrEqual(1);
  });
});
