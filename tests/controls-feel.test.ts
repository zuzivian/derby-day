// Controls feel: the red-team round 1b controls findings (loose balls, tackles, lofted passes,
// clicks) as tests. Each measures what the finding measured, and failed on main 96f9618.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { createMatch, step } from '../src/sim/match.ts';
import type { HumanInput, MatchPlayer, MatchState } from '../src/sim/types.ts';
import { dist, len, type Vec } from '../src/sim/vec.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

function livePlay(seed = 5): MatchState {
  const s = createMatch({ seed, ...teams(7), halfSeconds: 600, humanTeam: 0 });
  while (s.phase !== 'play') step(s);
  return s;
}

/** Everyone but `keep` is out of it: far away and on the floor. */
function isolate(s: MatchState, ...keep: MatchPlayer[]): void {
  for (const p of s.players) {
    if (keep.includes(p)) continue;
    p.stun = 100000;
    p.pos = { x: 52 + (p.i % 5), y: -2 - (p.i % 3) };
    p.vel = { x: 0, y: 0 };
  }
}

const role = (s: MatchState, team: 0 | 1, r: string, k = 0) => s.players.filter((p) => p.team === team && p.role === r)[k];

/** The human steers `me`, running at `speed` along +x from `at`; nobody else around. */
function runner(at: Vec, speed: number) {
  const s = livePlay();
  const me = role(s, 0, 'MID');
  isolate(s, me);
  s.switchTimer[0] = 1e9;
  s.controlled[0] = me.i;
  if (s.ctlHold) s.ctlHold[0] = false;
  me.pos = { ...at };
  me.vel = { x: speed, y: 0 };
  me.facing = { x: 1, y: 0 };
  me.stun = 0;
  return { s, me };
}

// ---------------------------------------------------------------------------
// Major 1: a steered player who takes the ball is not stopped dead

describe('the player you are steering keeps running when he takes the ball', () => {
  test('collecting a loose ball with the pointer resting ahead: still running 20 and 40 ticks later', () => {
    const { s, me } = runner({ x: 40, y: 34 }, 8);
    s.ball.owner = -1;
    s.ball.pos = { x: 44, y: 34 };
    s.ball.vel = { x: 0, y: 0 };
    s.ball.z = 0;
    // The hand moves the pointer out ahead, then rests 10+ m in front of him.
    const ahead = { x: 60, y: 34 };
    for (let t = 0; t < 12; t++) step(s, { cursor: { x: 48 + t, y: 34 }, moved: true });
    let got = -1;
    const speeds: number[] = [];
    for (let t = 0; t < 120; t++) {
      step(s, { cursor: ahead });
      if (got < 0 && s.ball.owner === me.i) got = t;
      if (got >= 0) speeds.push(len(me.vel));
      if (speeds.length > 41) break;
    }
    expect(got).toBeGreaterThanOrEqual(0);
    expect(speeds[20]).toBeGreaterThan(4);
    expect(speeds[40]).toBeGreaterThan(4);
    expect(s.ctlHold?.[0]).toBe(false);
  });

  test('a through ball into space onto a runner the human steers: he runs on with it', () => {
    const { s, me } = runner({ x: 40, y: 34 }, 7);
    // A ball played into space ahead of him (no receiver), still rolling.
    s.ball.owner = -1;
    s.ball.pos = { x: 45, y: 34.3 };
    s.ball.vel = { x: 4, y: 0 };
    s.ball.z = 0;
    s.ball.receiver = -1;
    s.ball.lastTouch = role(s, 0, 'DEF').i;
    const ahead = { x: 62, y: 34 };
    for (let t = 0; t < 10; t++) step(s, { cursor: { x: 52 + t, y: 34 }, moved: true });
    let got = -1;
    const speeds: number[] = [];
    for (let t = 0; t < 120; t++) {
      step(s, { cursor: ahead });
      if (got < 0 && s.ball.owner === me.i) got = t;
      if (got >= 0) speeds.push(len(me.vel));
      if (speeds.length > 31) break;
    }
    expect(got).toBeGreaterThanOrEqual(0);
    expect(speeds[20]).toBeGreaterThan(4);
    expect(speeds[30]).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// Major 2: right-click tackles win the ball where the click says they can

/** A CPU carrier at (40,34) running at our defender (from the front unless `still`); the human right-clicks on him from `gap` m. Watches 30 ticks. */
function tackleAt(gap: number, seed: number, opts: { still?: boolean; pointer?: 'carrier' | 'ball' } = {}) {
  const s = livePlay(seed);
  const me = role(s, 0, 'DEF');
  const opp = role(s, 1, 'MID');
  isolate(s, me, opp);
  s.controlled[0] = me.i;
  s.switchTimer[0] = 1e9;
  const v = opts.still ? 0 : -5;
  opp.pos = { x: 40, y: 34 };
  opp.vel = { x: v, y: 0 };
  opp.facing = { x: -1, y: 0 };
  opp.stun = 0;
  const b = s.ball;
  Object.assign(b, { owner: opp.i, pos: { x: 39, y: 34 }, vel: { x: v, y: 0 }, z: 0, vz: 0, receiver: -1, lastTouch: opp.i });
  b.noPickup.fill(0);
  me.stun = 0;
  me.tackleCd = 0;
  me.pos = { x: 40 - gap, y: 34 };
  me.vel = { x: 0, y: 0 };
  me.facing = { x: 1, y: 0 };
  const aim = opts.pointer === 'ball' ? { ...b.pos } : { ...opp.pos };
  const fouls0 = s.stats[0].fouls;
  const tk0 = s.stats[0].tackles;
  step(s, { cursor: aim, aim, tackle: true, moved: true });
  let closest = dist(me.pos, b.pos);
  for (let t = 0; t < 30 && s.phase === 'play' && s.stats[0].tackles === tk0; t++) {
    step(s, { cursor: aim });
    closest = Math.min(closest, dist(me.pos, b.pos));
  }
  return { won: s.stats[0].tackles > tk0, foul: s.stats[0].fouls > fouls0 || s.phase === 'restart', closest };
}

describe('right-click tackles (no dead band, slides that reach the ball can win it)', () => {
  const seeds = Array.from({ length: 30 }, (_, i) => i + 1);

  test('a standing tackle with the pointer on a carrier 1.8-2.3 m away can win the ball', () => {
    for (const gap of [1.8, 2.0, 2.3]) {
      const rs = seeds.map((sd) => tackleAt(gap, sd));
      const won = rs.filter((r) => r.won).length;
      // Main: 0 of 30 at every one of these distances.
      expect(won).toBeGreaterThanOrEqual(6);
    }
  });

  test('a slide from 3.5-4.5 m at a carrier reaches him and wins or fouls; it never just slides into him and stops', () => {
    for (const gap of [3.5, 4, 4.5]) {
      for (const still of [false, true]) {
        const rs = seeds.map((sd) => tackleAt(gap, sd, { still }));
        const reached = rs.filter((r) => r.won || r.foul).length;
        // Main: 0 of 30 (the slide was judged once, at the click, against 3 m).
        expect(reached).toBeGreaterThanOrEqual(20);
        expect(rs.filter((r) => r.won).length).toBeGreaterThanOrEqual(6);
      }
    }
  });

  test('the pointer on the ball rather than the man makes no difference to which tackle it is', () => {
    const a = seeds.map((sd) => tackleAt(1.9, sd, { pointer: 'ball' }));
    expect(a.filter((r) => r.won).length).toBeGreaterThanOrEqual(6);
  });
});
