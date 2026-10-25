import { describe, expect, test } from 'bun:test';
import { crowdLevel, detectSfx, initialSnapshot, snapshot, type SfxEvent } from '../src/client/audio.ts';
import { generateLadder, autoLineup, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W } from '../src/sim/constants.ts';
import { createMatch, step } from '../src/sim/match.ts';
import type { MatchEvent, MatchState } from '../src/sim/types.ts';

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

describe('detectSfx: referee, crowd and keeper', () => {
  const ev = (e: Record<string, unknown>) => e as unknown as MatchEvent;

  test('a foul or an offside gets one short whistle, however many events came at once', () => {
    const s = liveMatch();
    const before = snapshot(s);
    s.events.push(ev({ kind: 'foul', tick: s.tick }), ev({ kind: 'card', tick: s.tick }), ev({ kind: 'restart', tick: s.tick, restart: 'freekick', reason: 'foul' }));
    expect(detectSfx(before, s)).toEqual([{ type: 'whistle', kind: 'foul' }]);
    const again = snapshot(s);
    s.events.push(ev({ kind: 'offside', tick: s.tick }));
    expect(detectSfx(again, s)).toEqual([{ type: 'whistle', kind: 'foul' }]);
  });

  test('a shot going out just wide of the post draws an "ooh"; one well wide, or a slow ball, does not', () => {
    for (const [y, speed, want] of [
      [GOAL_TOP - 2, 22, true],
      [GOAL_BOTTOM + 3, 18, true],
      [(GOAL_TOP + GOAL_BOTTOM) / 2, 20, true], // over the bar
      [GOAL_TOP - 9, 22, false],
      [GOAL_TOP - 2, 6, false],
    ] as const) {
      const s = liveMatch();
      s.ball.pos = { x: PITCH_W - 1, y };
      s.ball.vel = { x: speed, y: 0 };
      const before = snapshot(s);
      s.phase = 'restart';
      s.events.push(ev({ kind: 'restart', tick: s.tick, restart: 'goalkick', reason: 'out' }));
      expect(types(detectSfx(before, s)).includes('ooh'), `y ${y}, ${speed} m/s`).toBe(want);
    }
  });

  test('a keeper catching a hard shot is a catch and an "ooh"; gathering a slow ball is just a catch', () => {
    for (const [speed, want] of [
      [24, ['catch', 'ooh']],
      [9, ['catch']],
    ] as const) {
      const s = liveMatch();
      const gk = s.players.find((p) => p.role === 'GK')!;
      s.ball.pos = { ...gk.pos };
      s.ball.vel = { x: speed, y: 0 };
      const before = snapshot(s);
      s.ball.owner = gk.i;
      s.ball.inHands = true;
      s.ball.vel = { x: 0, y: 0 };
      expect(types(detectSfx(before, s))).toEqual([...want]);
    }
  });

  test('a ball at head height turned by a nearby player is a header; with nobody near it is not', () => {
    for (const near of [true, false]) {
      const s = liveMatch();
      s.ball.pos = { x: 60, y: 30 };
      s.ball.z = 1.8;
      s.ball.vel = { x: 12, y: 0 };
      if (near) s.players[3].pos = { x: 60.5, y: 30 };
      const before = snapshot(s);
      s.ball.vel = { x: -9, y: 3 };
      expect(types(detectSfx(before, s)).includes('header')).toBe(near);
    }
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
        const k = e.type === 'whistle' ? `whistle:${e.kind === 'foul' ? 'foul' : 'phase'}` : e.type;
        counts[k] = (counts[k] ?? 0) + 1;
      }
      prev = snapshot(s);
    }
    const total = s.score[0] + s.score[1];
    expect(counts.goal ?? 0).toBe(total);
    expect(counts.kick).toBeGreaterThan(10);
    // opening kick-off, a restart per goal, second half, half-time, full-time
    expect(counts['whistle:phase']).toBe(1 + total + 1 + 1 + 1);
    // One foul whistle per tick with a foul or offside in it.
    const foulTicks = new Set(s.events.filter((e) => e.kind === 'foul' || e.kind === 'offside').map((e) => e.tick)).size;
    expect(counts['whistle:foul'] ?? 0).toBe(foulTicks);
    expect(counts.knock ?? 0).toBeLessThan(counts.kick * 2);
    // The crowd's "ooh" and the keeper's catch are occasional, not every kick.
    expect(counts.ooh ?? 0).toBeLessThan(counts.kick / 4);
    expect(counts.catch ?? 0).toBeLessThan(counts.kick / 2);
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
