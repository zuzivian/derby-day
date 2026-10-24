import { describe, expect, test } from 'bun:test';
import { acknowledge, CoachTracker, openTabs, pendingMark, TIPS } from '../src/client/coach.ts';
import { celebrationWords } from '../src/client/onboarding.ts';
import { toTeamSetup, generateSquad, autoLineup, generateIdentity } from '../src/meta/club.ts';
import { newGame } from '../src/meta/game.ts';
import { totalXpForLevel } from '../src/meta/levels.ts';
import { createMatch, step } from '../src/sim/match.ts';
import { makeRng } from '../src/sim/rng.ts';
import type { MatchState, Restart } from '../src/sim/types.ts';

function match(): MatchState {
  const team = (seed: number) => {
    const r = makeRng(seed);
    const squad = generateSquad(r, 55);
    return toTeamSetup(generateIdentity(r), squad, autoLineup(squad));
  };
  return createMatch({ seed: 7, home: team(1), away: team(2), humanTeam: 0 });
}

/** Run until the match is in open play. */
function toPlay(s: MatchState) {
  for (let i = 0; i < 60 * 40 && s.phase !== 'play'; i++) step(s, {});
  expect(s.phase).toBe('play');
}

describe('coach tracker', () => {
  test('offers the run tip a moment after the whistle, once', () => {
    const s = match();
    const c = new CoachTracker();
    expect(c.observe(s)).toEqual([]);
    for (let i = 0; i < 60; i++) step(s, {});
    expect(c.observe(s)).toContain('run');
    expect(c.observe(s)).toEqual([]);
    expect(c.take()).toBe('run'); // always first, even when the human already has the ball (then 'pass' follows)
    while (c.take()) c.observe(s);
    for (let i = 0; i < 120; i++) { step(s, {}); expect(c.observe(s)).not.toContain('run'); }
  });

  test('nothing else is offered before the run tip', () => {
    const s = match();
    toPlay(s);
    const me = s.controlled[0];
    s.tick = 10;
    s.players[me].pos = { x: 95, y: 34 };
    s.ball.owner = me;
    const c = new CoachTracker();
    expect(c.observe(s)).toEqual([]);
    s.tick = 50;
    expect(c.observe(s)).toEqual(['run', 'pass', 'shoot']);
  });

  test('tips already seen are never offered again', () => {
    const s = match();
    const c = new CoachTracker(['run', 'pass']);
    for (let i = 0; i < 60; i++) step(s, {});
    expect(c.observe(s)).toEqual([]);
    toPlay(s);
    s.ball.owner = s.controlled[0];
    expect(c.observe(s)).not.toContain('pass');
  });

  test('the first time with the ball offers a pass tip; near goal also a shot tip', () => {
    const s = match();
    toPlay(s);
    const me = s.controlled[0];
    const c = new CoachTracker(['run']);
    s.players[me].pos = { x: 30, y: 34 };
    s.ball.owner = me;
    expect(c.observe(s)).toEqual(['pass']);
    s.players[me].pos = { x: 95, y: 34 };
    expect(c.observe(s)).toEqual(['shoot']);
    expect(c.observe(s)).toEqual([]);
  });

  test('a shot tip needs to be near the goal being attacked, not the own goal', () => {
    const s = match();
    toPlay(s);
    const me = s.controlled[0];
    const c = new CoachTracker(['run']);
    s.players[me].pos = { x: 5, y: 34 };
    s.ball.owner = me;
    expect(c.observe(s)).toEqual(['pass']);
  });

  test('losing the ball offers the tackle tip', () => {
    const s = match();
    toPlay(s);
    const me = s.controlled[0];
    const c = new CoachTracker(['run', 'pass', 'shoot']);
    s.ball.owner = me;
    c.observe(s);
    s.ball.owner = s.players.find((p) => p.team === 1)!.i;
    expect(c.observe(s)).toEqual(['tackle']);
  });

  test('losing it to nobody, or the CPU starting with it, is not "losing the ball"', () => {
    const s = match();
    toPlay(s);
    const c = new CoachTracker(['run', 'pass', 'shoot']);
    s.ball.owner = s.players.find((p) => p.team === 1)!.i;
    expect(c.observe(s)).toEqual([]);
  });

  test('a restart your player takes offers the restart tip; kick-off and CPU restarts do not', () => {
    const s = match();
    toPlay(s);
    const me = s.controlled[0];
    const c = new CoachTracker(['run', 'pass', 'shoot', 'tackle']);
    const r = (over: Partial<Restart>): Restart => ({ kind: 'throwin', team: 0, spot: { x: 50, y: 0 }, taker: me, stage: 'ready', ticks: 0, direct: false, reason: 'out', wait: 0, ...over });
    s.restart = r({ kind: 'kickoff' });
    expect(c.observe(s)).toEqual([]);
    s.restart = r({ team: 1 });
    expect(c.observe(s)).toEqual([]);
    s.restart = r({ taker: -1 });
    expect(c.observe(s)).toEqual([]);
    s.restart = r({});
    expect(c.observe(s)).toEqual(['restart']);
  });

  test('every tip has words for mouse, keyboard and touch', () => {
    for (const t of Object.values(TIPS)) for (const text of [t.mouse, t.keys, t.touch]) expect(text.length).toBeGreaterThan(10);
  });
});

describe('tab marks', () => {
  test('a returning player (no marks) never gets one', () => {
    const s = newGame(1);
    s.xp = totalXpForLevel(6);
    expect(pendingMark(s, undefined, 'home')).toBeNull();
  });

  test('points at one newly revealed tab at a time, in order, and not at the tab you are on', () => {
    const s = newGame(2);
    const marks = ['home'];
    expect(pendingMark(s, marks, 'home')).toBeNull();
    s.xp = totalXpForLevel(4);
    expect(pendingMark(s, marks, 'home')!.screen).toBe('squad');
    expect(pendingMark(s, marks, 'squad')!.screen).toBe('club');
    expect(acknowledge(marks, 'squad')).toBe(true);
    expect(acknowledge(marks, 'squad')).toBe(false);
    expect(acknowledge(marks, 'home')).toBe(false);
    expect(pendingMark(s, marks, 'home')!.screen).toBe('club');
    acknowledge(marks, 'club');
    expect(pendingMark(s, marks, 'home')!.screen).toBe('training');
  });

  test('a first-run club starts with only Home seen; a bigger club starts with what it has open', () => {
    const s = newGame(3);
    expect(openTabs(s)).toEqual(['home']);
    s.xp = totalXpForLevel(5);
    expect(openTabs(s)).toEqual(['home', 'squad', 'club', 'training', 'transfers']);
  });
});

describe('first match celebration', () => {
  test('warm words for a win, a draw and a defeat', () => {
    expect(celebrationWords(2, 1).title).toBe('What a start!');
    expect(celebrationWords(1, 1).title).toBe('Honours even');
    expect(celebrationWords(0, 3).title).toBe('Good effort');
  });
});
