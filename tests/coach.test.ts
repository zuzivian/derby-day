import { describe, expect, test } from 'bun:test';
import { acknowledge, CoachTracker, minTipMs, openTabs, pendingMark, SEEN_AFTER_MS, TIPS, tipText } from '../src/client/coach.ts';
import { celebrationWords } from '../src/client/onboarding.ts';
import { toTeamSetup, generateSquad, autoLineup, generateIdentity } from '../src/meta/club.ts';
import { isSave, newGame } from '../src/meta/game.ts';
import { completeFirstMatch } from '../src/client/firstrun.ts';
import type { Prefs } from '../src/client/store.ts';
import { pendingUnlocks, totalXpForLevel } from '../src/meta/levels.ts';
import { createMatch, step } from '../src/sim/match.ts';
import { makeRng } from '../src/sim/rng.ts';
import type { MatchState, Restart } from '../src/sim/types.ts';
import { kickOff } from './helpers.ts';

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
  kickOff(s);
  expect(s.phase).toBe('play');
}

describe('coach tracker', () => {
  test('offers the run tip a moment after the whistle, once', () => {
    const s = match();
    const c = new CoachTracker();
    expect(c.observe(s)).toEqual(['pass']); // he stands over the kick-off and the click is waiting: how to pass is due at once
    for (let i = 0; i < 60; i++) step(s, {});
    expect(c.observe(s)).toEqual(['run']);
    expect(c.observe(s)).toEqual([]);
    expect(c.take()).toBe('pass'); // the human holds the ball at kick-off, so what to do with it comes before how to run
    expect(c.take()).toBe('run');
    while (c.take()) c.observe(s);
    for (let i = 0; i < 120; i++) { step(s, {}); expect(c.observe(s)).not.toContain('run'); }
  });

  test('the kick-off he takes is a pass (Law 8): the pass tip comes first, as soon as the click is waiting', () => {
    const s = match();
    const c = new CoachTracker();
    for (let i = 0; i < 60; i++) {
      step(s, {});
      c.observe(s);
    }
    expect(s.phase).toBe('restart');
    expect(s.restart!.kind).toBe('kickoff');
    expect(s.restart!.taker).toBe(s.controlled[0]);
    expect(c.queue).toEqual(['pass', 'run']);
    expect(c.take()).toBe('pass');
    expect(c.relevant('pass', s)).toBe(true);
  });

  test('the pass tip does not wait for the run tip when the kick-off is ready early', () => {
    const s = match();
    const c = new CoachTracker();
    let n = 0;
    while (!(s.phase === 'restart' && s.restart!.kind === 'kickoff' && s.restart!.stage === 'ready') && n++ < 600) step(s, {});
    expect(s.restart!.stage).toBe('ready');
    s.tick = 5; // before the run tip's moment
    expect(c.observe(s)).toEqual(['pass']);
  });

  test('nothing is offered before the whistle has settled', () => {
    const s = match();
    toPlay(s);
    const me = s.controlled[0];
    s.tick = 10;
    s.players[me].pos = { x: 95, y: 34 };
    s.ball.owner = me;
    const c = new CoachTracker();
    expect(c.observe(s)).toEqual([]);
    s.tick = 50;
    expect(c.observe(s)).toEqual(['pass', 'run', 'shoot']);
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

describe('coach timing and relevance', () => {
  test('a tip stays up long enough to read: about four words a second, never under five seconds', () => {
    for (const t of Object.values(TIPS)) {
      for (const text of [t.mouse, t.keys, t.touch]) {
        const words = text.split(/\s+/).length;
        expect(minTipMs(text)).toBeGreaterThanOrEqual(5000);
        expect(minTipMs(text)).toBeGreaterThanOrEqual(words * 250);
      }
    }
    // The cascade the review found: run was cut at 2.5 s with 20+ words on screen. It now holds well past that.
    expect(minTipMs(TIPS.run.mouse)).toBeGreaterThanOrEqual(5000);
    expect(minTipMs(TIPS.run.mouse)).toBeGreaterThan(SEEN_AFTER_MS);
  });

  test('a queued tip that is no longer true when its turn comes is dropped, and can be offered again later', () => {
    const s = match();
    toPlay(s);
    const me = s.controlled[0];
    const c = new CoachTracker(['run']);
    s.players[me].pos = { x: 30, y: 34 };
    s.ball.owner = me;
    expect(c.observe(s)).toEqual(['pass']);
    s.ball.owner = s.players.find((p) => p.team === 1)!.i; // lost it before the tip got its turn
    expect(c.take(s)).toBeUndefined();
    s.ball.owner = me; // the next possession offers it again
    expect(c.observe(s)).toEqual(['pass']);
    expect(c.take(s)).toBe('pass');
  });

  test('a tip cut short is forgotten, so it comes back', () => {
    const s = match();
    for (let i = 0; i < 60; i++) step(s, {});
    const c = new CoachTracker(['pass']);
    c.observe(s);
    expect(c.take(s)).toBe('run');
    expect(c.observe(s)).toEqual([]);
    c.forget('run');
    expect(c.observe(s)).toEqual(['run']);
  });

  test('restart is only relevant while the restart is live and yours', () => {
    const s = match();
    toPlay(s);
    const c = new CoachTracker(['run']);
    expect(c.relevant('restart', s)).toBe(false);
    s.restart = { kind: 'corner', team: 0, spot: { x: 0, y: 0 }, taker: s.controlled[0], stage: 'ready', ticks: 0, direct: true, reason: 'out', wait: 0 };
    expect(c.relevant('restart', s)).toBe(true);
    s.restart = null;
    expect(c.relevant('restart', s)).toBe(false);
  });

  test('the shoot tip waits until the player is in range of goal', () => {
    const s = match();
    toPlay(s);
    const me = s.controlled[0];
    const c = new CoachTracker(['run']);
    s.players[me].pos = { x: 60, y: 10 };
    s.ball.owner = me;
    expect(c.observe(s)).toEqual(['pass']); // 51 m out
    expect(c.relevant('shoot', s)).toBe(false);
    s.players[me].pos = { x: 85, y: 30 };
    expect(c.observe(s)).toEqual(['shoot']); // about 20 m out
    expect(c.relevant('shoot', s)).toBe(true);
  });

  test('no shoot tip at kick-off, 52 m from goal', () => {
    const s = match();
    const c = new CoachTracker();
    for (let i = 0; i < 60; i++) step(s, {});
    expect(c.observe(s)).not.toContain('shoot');
    expect(c.relevant('shoot', s)).toBe(false);
  });

  test('a queued shoot tip is dropped once the player has dribbled out of range', () => {
    const s = match();
    toPlay(s);
    const me = s.controlled[0];
    const c = new CoachTracker(['run', 'pass']);
    s.players[me].pos = { x: 90, y: 34 };
    s.ball.owner = me;
    expect(c.observe(s)).toEqual(['shoot']);
    s.players[me].pos = { x: 50, y: 34 };
    expect(c.take(s)).toBeUndefined();
  });

  test('the words follow the live input: touch first, then keys or mouse; the run tip mentions both', () => {
    expect(tipText('pass', 'mouse', false)).toBe(TIPS.pass.mouse);
    expect(tipText('pass', 'keys', false)).toBe(TIPS.pass.keys);
    expect(tipText('pass', 'keys', true)).toBe(TIPS.pass.touch);
    expect(TIPS.run.mouse).toMatch(/WASD/);
    expect(TIPS.run.keys).toMatch(/mouse/);
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
    expect(openTabs(s)).toEqual(['home', 'squad', 'club', 'training', 'competitions']);
  });
});

describe('first match celebration', () => {
  test('warm words for a win, a draw and a defeat', () => {
    expect(celebrationWords(2, 1).title).toBe('What a start!');
    expect(celebrationWords(1, 1).title).toBe('Honours even');
    expect(celebrationWords(0, 3).title).toBe('Good effort');
  });
});

describe('the end of the first match', () => {
  const firstMatch = (gf: number, ga: number) => {
    const s = newGame(11);
    const prefs: Prefs = { halfSeconds: 3, controls: 'mouse', onboarded: false, coachSeen: ['run'], marks: ['home'] };
    const out = completeFirstMatch(s, prefs, { gf, ga, scorers: [], opponent: { name: 'Marsund Rangers', short: 'MSD' } });
    return { s, prefs, out };
  };

  test('is final the moment the celebration can mount: recorded, XP in, milestone claimed, setup over', () => {
    for (const [gf, ga] of [[2, 1], [0, 0], [0, 3]]) {
      const { s, prefs, out } = firstMatch(gf, ga);
      expect(s.history.length).toBe(1);
      expect(s.history[0].ranked).toBe(false);
      expect(s.club.elo).toBe(1000);
      expect(s.milestones).toContain('first-match');
      expect(s.xp).toBeGreaterThanOrEqual(100); // even a defeat reaches level 2
      expect(out.summary.xp.total).toBe(s.xp!);
      expect(prefs.onboarded).toBe(true);
    }
  });

  test('what level 2 opens is named for the celebration and marked seen, so no dialog or mark repeats it', () => {
    const { s, prefs, out } = firstMatch(1, 0);
    expect(out.opened).toEqual(['Squad', 'vs Player: one screen', 'vs Player: two tabs', 'Practice: Easy']);
    expect(pendingUnlocks(s)).toEqual([]);
    expect(prefs.marks).toEqual(['home', 'squad']);
    expect(pendingMark(s, prefs.marks, 'home')).toBeNull();
  });

  test('keeps the prefs it was given: the coach tips already shown are not discarded', () => {
    const { prefs } = firstMatch(1, 1);
    expect(prefs.coachSeen).toEqual(['run']);
    expect(prefs.halfSeconds).toBe(3);
    expect(prefs.controls).toBe('mouse');
  });

  test('the save and the prefs round-trip through JSON as a reload would read them', () => {
    const { s, prefs } = firstMatch(3, 0);
    const save = JSON.parse(JSON.stringify(s));
    expect(isSave(save)).toBe(true);
    expect(save.history.length).toBe(1);
    expect(JSON.parse(JSON.stringify(prefs)).onboarded).toBe(true);
  });
});
