import { describe, expect, test } from 'bun:test';
import { createMatchTelemetry } from '../src/client/matchTelemetry.ts';
import { createTelemetry, type TelemetryDeps, type TelemetryEvent } from '../src/client/telemetry.ts';
import type { GoalEvent, MatchState } from '../src/sim/types.ts';

type Progress = Pick<MatchState, 'tick' | 'goals' | 'score' | 'phase' | 'abandoned'>;
const state = (tick: number, goals: GoalEvent[] = [], score: [number, number] = [0, 0]): Progress => ({ tick, goals, score, phase: 'play' });
const goal = (team: 0 | 1, tick: number): GoalEvent => ({ kind: 'goal', tick, team, minute: 1, second: 0, player: 1, scorer: 'Private player name', ownGoal: false, from: 'play' });

function capture() {
  const events: TelemetryEvent[] = [];
  let flushes = 0;
  const metrics = createMatchTelemetry({ track: (e) => events.push(e), flush: () => { flushes++; } }, 'Ranked', 'mouse', 0);
  return { events, metrics, flushes: () => flushes };
}

describe('CPU match feel measurements', () => {
  test('only the first player-team goal is reported, at its exact sim tick, even if a frame sees several goals', () => {
    const { metrics, events } = capture();
    const opponentGoal = goal(1, 120);
    metrics.observe(state(180, [opponentGoal], [0, 1]));
    expect(events.map((e) => e.name)).toEqual(['match_start']);
    // A frame catches up several ticks: report the event's tick, not the current frame/tick.
    const goals = [opponentGoal, goal(0, 301), goal(0, 360)];
    metrics.observe(state(400, goals, [2, 1]));
    metrics.observe(state(500, goals, [2, 1]));
    metrics.finish({ ...state(600, goals, [2, 1]), phase: 'fulltime' }, false);
    expect(events).toEqual([
      { name: 'match_start', kind: 'Ranked', controls: 'mouse' },
      { name: 'first_player_goal', kind: 'Ranked', activeSeconds: 5.017 },
      { name: 'match_end', kind: 'Ranked', score: [2, 1], forfeit: false, outcome: 'completed', activeSeconds: 10 },
    ]);
    expect(JSON.stringify(events)).not.toContain('Private player name');
  });

  test('repeated paused/replay frames do not inflate duration or report goals from playback', () => {
    const { metrics, events } = capture();
    // The view calls observe only after live steps. A minute spent paused/replaying
    // produces no observations; repeated renders of the same live state also add no time.
    const live = state(120);
    for (let i = 0; i < 300; i++) metrics.observe(live);
    metrics.finish(live, true);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ activeSeconds: 2, outcome: 'forfeit', forfeit: true });
  });

  test('an away-side human gets the correct first goal and score perspective', () => {
    const events: TelemetryEvent[] = [];
    const metrics = createMatchTelemetry({ track: (e) => events.push(e), flush() {} }, 'Practice', 'keys', 1);
    metrics.finish({ ...state(600, [goal(0, 60), goal(1, 120)], [3, 1]), phase: 'fulltime' }, false);
    expect(events[1]).toMatchObject({ name: 'first_player_goal', activeSeconds: 2 });
    expect(events[2]).toMatchObject({ score: [1, 3], outcome: 'completed' });
  });

  test('rules abandonment and page exit remain distinct from forfeits, and terminal callbacks cannot double count', () => {
    for (const mode of ['rules', 'exit'] as const) {
      const { metrics, events, flushes } = capture();
      const live = state(300, [goal(0, 240)], [1, 0]);
      if (mode === 'rules') metrics.finish({ ...live, phase: 'fulltime', abandoned: { team: 1, score: [3, 0] } }, false);
      else metrics.abandon(live);
      metrics.finish(live, true);
      metrics.abandon(live);
      metrics.observe(state(600, [...live.goals, goal(0, 500)]));
      expect(events.filter((e) => e.name === 'match_end')).toEqual([
        { name: 'match_end', kind: 'Ranked', score: [1, 0], forfeit: false, outcome: 'abandoned', activeSeconds: 5 },
      ]);
      expect(events.filter((e) => e.name === 'first_player_goal')).toHaveLength(1);
      expect(flushes()).toBeGreaterThan(0);
    }
  });

  test('leaving during the full-time banner counts as completed; a scoreless match sends no goal event', () => {
    const { metrics, events } = capture();
    metrics.abandon({ ...state(900), phase: 'fulltime' });
    expect(events.map((e) => e.name)).toEqual(['match_start', 'match_end']);
    expect(events[1]).toMatchObject({ outcome: 'completed', activeSeconds: 15 });
  });
});

describe('match measurement privacy and delivery', () => {
  function setup(over: Partial<TelemetryDeps> = {}) {
    const stored = new Map<string, string>();
    const bodies: { events: TelemetryEvent[] }[] = [];
    const t = createTelemetry({
      url: 'https://test.invalid/events', dnt: false, gpc: false,
      store: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); } },
      now: () => 1000, random: () => 'random-install-id',
      send: (_url, body) => { bodies.push(JSON.parse(body)); return true; },
      ...over,
    });
    return { t, stored, bodies };
  }

  test('no endpoint, DNT, GPC and guest mode suppress every lifecycle event and analytics storage', () => {
    for (const over of [{ url: '' }, { dnt: true }, { gpc: true }, { suspended: () => true }]) {
      const { t, stored, bodies } = setup(over);
      const metrics = createMatchTelemetry(t, 'Ranked', 'mouse', 0);
      metrics.observe(state(120, [goal(0, 60)], [1, 0]));
      metrics.abandon(state(120));
      t.flush();
      expect(bodies).toHaveLength(0);
      expect(stored.size).toBe(0);
    }
  });

  test('opting out mid-match clears queued starts/goals and suppresses the ending event', () => {
    const { t, bodies } = setup();
    const metrics = createMatchTelemetry(t, 'Ranked', 'mouse', 0);
    metrics.observe(state(120, [goal(0, 60)], [1, 0]));
    t.setOptOut(true);
    metrics.abandon(state(240));
    expect(bodies).toHaveLength(0);
  });

  test('page exit flushes its terminal event even if the global pagehide flush ran first', () => {
    const { t, bodies } = setup();
    const metrics = createMatchTelemetry(t, 'Ranked', 'mouse', 0);
    t.flush(); // the global listener was installed before the view's listener
    metrics.abandon(state(600));
    expect(bodies).toHaveLength(2);
    expect(bodies[1].events).toEqual([
      { name: 'match_end', t: 1000, kind: 'Ranked', score: [0, 0], forfeit: false, outcome: 'abandoned', activeSeconds: 10 },
    ]);
  });
});
