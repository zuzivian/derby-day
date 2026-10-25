// The 3D renderer's state reading, without a browser: the animation director
// turns sim changes into events, the HUD words come from the sim's events,
// and the HUD clock is matchSeconds.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { createMatch, step } from '../src/sim/match.ts';
import { matchSeconds } from '../src/sim/rules.ts';
import type { MatchState } from '../src/sim/types.ts';
import { matchClock, refereeWord } from '../src/client/hud.ts';
import { AnimDirector, inWall, keeperSet } from '../src/client/r3d/director.ts';
import type { AnimEvent } from '../src/client/r3d/player3d.ts';

function cpuMatch(seed: number, halfSeconds = 60): MatchState {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return createMatch({ seed, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds, humans: [false, false] });
}

/** Play a CPU match through a director sampling every other tick, like a 30 fps renderer. */
function watch(seed: number) {
  const s = cpuMatch(seed);
  const d = new AnimDirector();
  const seen = new Map<string, number>();
  let goals = 0;
  let refCards = 0;
  let walls = 0;
  for (let frames = 0; s.phase !== 'fulltime' && frames < 40_000; frames++) {
    step(s);
    step(s);
    const out = d.update(s, s.tick / 60);
    if (out.goal) goals++;
    refCards += out.referee.filter((e) => e.kind === 'card').length;
    for (const list of out.events) for (const e of list as AnimEvent[]) seen.set(e.kind, (seen.get(e.kind) ?? 0) + 1);
    if (s.restart?.kind === 'freekick' && s.restart.stage === 'ready') walls += s.players.filter((p) => inWall(s, p)).length;
  }
  return { s, seen, goals, refCards, walls };
}

describe('3D animation director', () => {
  test('an 11 v 11 CPU match produces kicks, tackles and celebrations, and the referee shows every card', () => {
    let kicks = 0;
    let tackles = 0;
    for (const seed of [11, 12, 13]) {
      const { s, seen, goals, refCards } = watch(seed);
      expect(s.players.length).toBe(22);
      kicks += seen.get('kick') ?? 0;
      tackles += seen.get('tackle') ?? 0;
      expect(goals).toBe(s.goals.length);
      expect(seen.get('celebrate') ?? 0).toBe(s.goals.filter((g) => !g.ownGoal).length);
      expect(refCards).toBe(s.cards.length);
    }
    expect(kicks).toBeGreaterThan(100);
    expect(tackles).toBeGreaterThan(0);
  });

  test('a seek (tick jump) resets instead of firing a burst of events', () => {
    const s = cpuMatch(14);
    const d = new AnimDirector();
    d.update(s, 0);
    for (let i = 0; i < 600; i++) step(s);
    const out = d.update(s, 10);
    expect(out.events.every((l) => l.length === 0)).toBe(true);
    expect(out.goal).toBeNull();
  });

  test('keepers set when the other side has the ball near them, not when their own side does', () => {
    const s = cpuMatch(15);
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

  test('a defender between a free kick and his goal, 9 m out, is in the wall', () => {
    const s = cpuMatch(16);
    const def = s.players.find((p) => p.team === 0 && p.role === 'DEF')!;
    s.restart = { kind: 'freekick', team: 1, spot: { x: 30, y: 34 }, taker: -1, stage: 'ready', ticks: 0, direct: true, reason: 'foul', wait: 0 };
    def.pos = { x: 20.8, y: 34.5 };
    expect(inWall(s, def)).toBe(true);
    def.pos = { x: 40, y: 34 };
    expect(inWall(s, def)).toBe(false);
  });
});

describe('HUD', () => {
  test('referee words for the sim events', () => {
    // Find a match with fouls, cards and offsides in it.
    let s: MatchState | null = null;
    for (let seed = 20; seed < 80 && !s; seed++) {
      const m = watch(seed).s;
      if (m.cards.length && m.events.some((e) => e.kind === 'offside') && m.events.some((e) => e.kind === 'foul' && !e.advantage)) s = m;
    }
    expect(s).not.toBeNull();
    const m = s!;
    const words = new Set(m.events.map((e) => refereeWord(m, e)?.word).filter(Boolean));
    expect(words.has('Offside')).toBe(true);
    expect(words.has('Foul') || words.has('Penalty')).toBe(true);
    expect(words.has('Yellow card') || words.has('Red card')).toBe(true);
    const card = m.events.find((e) => e.kind === 'card')!;
    expect(refereeWord(m, card)?.sub).toContain(card.kind === 'card' ? card.name : '');
  });

  test('the clock is matchSeconds as MM:SS and holds through a stoppage', () => {
    const s = cpuMatch(17);
    expect(matchClock(s)).toBe('00:00');
    s.clock = s.halfTicks;
    expect(matchClock(s)).toBe('45:00');
    expect(matchSeconds(s)).toBe(2700);
    s.phase = 'goal';
    expect(matchClock(s)).toBe('45:00');
    s.clock = s.halfTicks * 2 + 500;
    expect(matchClock(s)).toBe('90:00');
  });
});
