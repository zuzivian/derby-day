// The 3D renderer's state reading, without a browser: the animation director
// turns sim changes into events, optional richer-sim fields are read
// defensively, and the HUD clock counts match time.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { createMatch, step } from '../src/sim/match.ts';
import type { MatchState } from '../src/sim/types.ts';
import { matchClock } from '../src/client/hud.ts';
import { AnimDirector, classifyEvent, keeperSet, readReferee, readRestart } from '../src/client/r3d/director.ts';
import type { AnimEvent } from '../src/client/r3d/player3d.ts';

function cpuMatch(seed: number, halfSeconds = 40): MatchState {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return createMatch({ seed, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds, humans: [false, false] });
}

describe('3D animation director', () => {
  test('a CPU match produces kicks, tackles and celebrations, and only from real state changes', () => {
    const s = cpuMatch(11);
    const d = new AnimDirector();
    const seen = new Map<string, number>();
    let goals = 0;
    let frames = 0;
    // Sample every other tick, like a renderer at 30 fps.
    while (s.phase !== 'fulltime' && frames < 20_000) {
      step(s);
      step(s);
      frames++;
      const out = d.update(s, s.tick / 60);
      if (out.goal) goals++;
      for (const list of out.events) for (const e of list as AnimEvent[]) seen.set(e.kind, (seen.get(e.kind) ?? 0) + 1);
    }
    expect(seen.get('kick') ?? 0).toBeGreaterThan(30);
    expect(seen.get('tackle') ?? 0).toBeGreaterThan(0);
    expect(goals).toBe(s.score[0] + s.score[1]);
    if (goals > 0) expect(seen.get('celebrate') ?? 0).toBe(goals);
  });

  test('a seek (tick jump) resets instead of firing a burst of events', () => {
    const s = cpuMatch(12);
    const d = new AnimDirector();
    d.update(s, 0);
    for (let i = 0; i < 600; i++) step(s);
    const out = d.update(s, 10);
    expect(out.events.every((l) => l.length === 0)).toBe(true);
    expect(out.goal).toBeNull();
  });

  test('keepers set when the other side has the ball near them, not when their own side does', () => {
    const s = cpuMatch(13);
    s.phase = 'play';
    const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
    const fwd = s.players.find((p) => p.team === 1 && p.role === 'FWD')!;
    const def = s.players.find((p) => p.team === 0 && p.role === 'DEF')!;
    s.ball.pos = { x: gk.pos.x + 8, y: gk.pos.y };
    s.ball.owner = fwd.i;
    expect(keeperSet(s, gk)).toBeGreaterThan(0.5);
    s.ball.owner = def.i;
    expect(keeperSet(s, gk)).toBe(0);
  });
});

describe('optional richer-sim fields', () => {
  test('restart, referee and card events are read when present and ignored when absent', () => {
    const s = cpuMatch(14);
    expect(readRestart(s)).toBeNull();
    expect(readReferee(s)).toBeNull();
    const loose = s as unknown as Record<string, unknown>;
    loose.restart = { kind: 'throwin', taker: 3, team: 0 };
    expect(readRestart(s)).toEqual({ kind: 'throwin', taker: 3 });
    loose.referee = { pos: { x: 10, y: 5 }, vel: { x: 1, y: 0 } };
    expect(readReferee(s)?.pos).toEqual({ x: 10, y: 5 });
    expect(classifyEvent(s, { tick: 1, minute: 1, team: 0, scorer: 'A' }).kind).toBe('goal');
    const card = classifyEvent(s, { kind: 'card', card: 'red', player: 4 });
    expect(card).toEqual({ kind: 'card', card: { player: 4, color: 'red' } });
    const byName = classifyEvent(s, { type: 'yellow', name: s.players[2].name });
    expect(byName.card).toEqual({ player: 2, color: 'yellow' });
    expect(classifyEvent(s, { kind: 'foul' }).kind).toBe('foul');
    expect(classifyEvent(s, { kind: 'offside' }).kind).toBe('offside');
  });
});

describe('HUD clock', () => {
  test('counts 90 shown minutes as MM:SS', () => {
    const s = cpuMatch(15, 60);
    expect(matchClock(s)).toBe('00:00');
    s.clock = s.halfTicks;
    expect(matchClock(s)).toBe('45:00');
    s.clock = s.halfTicks * 2 + 500;
    expect(matchClock(s)).toBe('90:00');
  });
});
