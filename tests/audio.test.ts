import { describe, expect, test } from 'bun:test';
import { MIX, busOf, crowdNoise, crowdTarget, kickVoice, softClip, uiNotes, crowdLevel, detectSfx, goalMood, resultMood, tension, initialSnapshot, snapshot, stingerLength, stingerNotes, type SfxEvent } from '../src/client/audio.ts';
import { generateLadder, autoLineup, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W, STAND_CD } from '../src/sim/constants.ts';
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
    s.players[2].tackleCd = STAND_CD;
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

describe('detectSfx referee calls', () => {
  const withEvent = (e: Record<string, unknown>) => {
    const s = liveMatch();
    s.ball.pos = { x: 30, y: 20 };
    const prev = snapshot(s);
    s.events.push({ tick: s.tick, player: 0, team: 0, ...e } as unknown as MatchEvent);
    return detectSfx(prev, s);
  };
  test('cards, offside and penalties get a call cue', () => {
    expect(withEvent({ kind: 'card', color: 'yellow', name: 'A', secondYellow: false, reason: 'foul' })).toContainEqual({ type: 'call', kind: 'yellow' });
    expect(withEvent({ kind: 'card', color: 'red', name: 'A', secondYellow: false, reason: 'foul' })).toContainEqual({ type: 'call', kind: 'red' });
    expect(withEvent({ kind: 'offside', spot: { x: 1, y: 1 } })).toContainEqual({ type: 'call', kind: 'offside' });
    expect(withEvent({ kind: 'foul', penalty: true, advantage: false, victim: 1, spot: { x: 1, y: 1 }, severity: 'reckless' })).toContainEqual({ type: 'call', kind: 'penalty' });
  });
  test('a second yellow sounds once, as the red', () => {
    const evs = withEvent({ kind: 'card', color: 'yellow', name: 'A', secondYellow: true, reason: 'foul' });
    expect(evs.filter((e) => e.type === 'call')).toEqual([]);
  });
});

describe('UI stingers', () => {
  test('a win rises through a major arpeggio; a loss is lower and quieter; a draw is level and soft', () => {
    const win = stingerNotes('win');
    expect(win.map((n) => n.f)).toEqual([...win.map((n) => n.f)].sort((a, b) => a - b));
    const peak = (k: 'win' | 'draw' | 'loss' | 'levelup') => Math.max(...stingerNotes(k).map((n) => n.peak));
    expect(peak('loss')).toBeLessThan(peak('win'));
    expect(peak('draw')).toBeLessThan(peak('win'));
    expect(Math.max(...stingerNotes('loss').map((n) => n.f))).toBeLessThan(Math.min(...win.map((n) => n.f)));
  });
  test('the level-up run is longer than the win, and every jingle is short', () => {
    expect(stingerLength('levelup')).toBeGreaterThan(stingerLength('win'));
    for (const k of ['win', 'draw', 'loss', 'levelup'] as const) expect(stingerLength(k)).toBeLessThan(2);
  });
});

describe('atmosphere helpers', () => {
  const mk = (): MatchState => createMatch({ seed: 5, ...teams(7), halfSeconds: 30, humanTeam: -1 });
  test('tension: none early or in a rout, building late in a close second half', () => {
    const s = mk();
    expect(tension(s)).toBe(0);
    s.half = 2;
    s.clock = Math.floor(s.halfTicks * 2 * 0.95);
    expect(tension(s)).toBeGreaterThan(0.6);
    s.score = [3, 0];
    expect(tension(s)).toBe(0);
  });
  test('goalMood and resultMood read the human side', () => {
    const s = mk();
    s.humans = [true, false];
    s.score = [1, 1];
    expect(goalMood(s, 0)).toEqual({ side: 'for', big: true });
    expect(goalMood(s, 1).side).toBe('against');
    s.score = [4, 0];
    expect(goalMood(s, 0).big).toBe(false);
    expect(resultMood(s)).toBe('win');
    s.humans = [false, true];
    expect(resultMood(s)).toBe('loss');
  });
});

describe('mix and envelopes', () => {
  test('every event type has a bus, and the bus gains are sane', () => {
    const all: SfxEvent['type'][] = ['kick', 'knock', 'tackle', 'goal', 'whistle', 'ooh', 'catch', 'header', 'call'];
    for (const t of all) expect(Object.keys(MIX)).toContain(busOf(t));
    expect(busOf('whistle')).toBe('ref');
    expect(busOf('call')).toBe('ref');
    expect(busOf('ooh')).toBe('crowd');
    expect(busOf('kick')).toBe('ball');
    for (const g of Object.values(MIX)) expect(g).toBeGreaterThan(0);
    // Menu sounds sit far below everything in the match.
    for (const k of ['crowd', 'ball', 'ref', 'stinger'] as const) expect(MIX.ui).toBeLessThan(MIX[k] / 3);
  });

  test('kick voices get louder, higher and crisper with power; shots outweigh passes', () => {
    for (const kind of ['pass', 'shot'] as const) {
      const soft = kickVoice(kind, 0);
      const hard = kickVoice(kind, 1);
      expect(hard.body).toBeGreaterThan(soft.body);
      expect(hard.f0).toBeGreaterThan(soft.f0);
      expect(hard.snap).toBeGreaterThan(soft.snap);
      expect(soft.crack).toBe(0);
      expect(hard.crack).toBeGreaterThan(0);
      // Out-of-range power is clamped, not extrapolated.
      expect(kickVoice(kind, 5)).toEqual(hard);
      expect(kickVoice(kind, -1)).toEqual(soft);
    }
    expect(kickVoice('shot', 0.5).body).toBeGreaterThan(kickVoice('pass', 0.5).body);
    for (const p of [0, 0.3, 0.7, 1]) for (const kind of ['pass', 'shot'] as const) {
      const v = kickVoice(kind, p);
      expect(v.body + v.snap + v.thud + v.crack).toBeLessThan(1.5);
    }
  });

  test('crowd target rises smoothly with intensity and is clamped', () => {
    let prev = crowdTarget(0);
    expect(prev.gain).toBeGreaterThan(0);
    for (let l = 0.05; l <= 1.0001; l += 0.05) {
      const c = crowdTarget(l);
      expect(c.gain).toBeGreaterThan(prev.gain);
      expect(c.band).toBeGreaterThan(prev.band);
      expect(c.low).toBeGreaterThan(prev.low);
      prev = c;
    }
    expect(crowdTarget(7)).toEqual(crowdTarget(1));
    expect(crowdTarget(-1)).toEqual(crowdTarget(0));
  });

  test('soft clip: identity below the knee, monotonic, odd and never reaches full scale', () => {
    expect(softClip(0.3)).toBe(0.3);
    expect(softClip(-0.5)).toBe(-0.5);
    let prev = -Infinity;
    for (let x = -50; x <= 50; x += 0.01) {
      const y = softClip(x);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(Math.abs(y)).toBeLessThan(0.99);
      expect(softClip(-x)).toBeCloseTo(-y, 12);
      prev = y;
    }
    // No jump at the knee.
    expect(Math.abs(softClip(0.6001) - softClip(0.6))).toBeLessThan(0.001);
  });

  test('crowd noise loops without a step at the seam', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const d = new Float32Array(44100);
    crowdNoise(d, 2048, rnd);
    let typical = 0;
    for (let i = 5000; i < 9000; i++) typical = Math.max(typical, Math.abs(d[i] - d[i - 1]));
    expect(Math.abs(d[0] - d[d.length - 1])).toBeLessThan(typical * 2);
    expect(Math.max(...d)).toBeLessThan(4);
  });

  test('UI sounds are short, quiet in-bus, and cover every kind', () => {
    for (const k of ['press', 'on', 'off', 'ok', 'warn'] as const) {
      const notes = uiNotes(k);
      expect(notes.length).toBeGreaterThan(0);
      for (const n of notes) {
        expect(n.at + n.dur).toBeLessThan(0.5);
        expect(n.peak).toBeLessThanOrEqual(0.6);
        expect(n.wave).toBe('sine');
      }
    }
    // Switching on rises, switching off falls.
    const up = uiNotes('on');
    const down = uiNotes('off');
    expect(up[1].f).toBeGreaterThan(up[0].f);
    expect(down[1].f).toBeLessThan(down[0].f);
  });
});
