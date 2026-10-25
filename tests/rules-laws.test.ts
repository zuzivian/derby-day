// The Laws the red team found missing (round 1b): a real kick-off (Law 8), no second touch
// at a restart (Laws 8, 13-17) or keeper handling of his own goal kick or release (Law 12),
// offside judged again on a teammate's header or deflection (Law 11), a defender's header
// to his keeper is not a back-pass (Law 12), a late challenge after a shot lets the shot
// play out (Law 12), advantage brought back only when it came to nothing, added time
// (Law 7) and fewer than seven players (Law 3).

import { describe, expect, test } from 'bun:test';
import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { GOAL_BOTTOM, GOAL_TOP, KICKOFF_PAUSE, PITCH_H, PITCH_W, RESTART_HUMAN_WAIT } from '../src/sim/constants.ts';
import { attackDir, inOffsidePosition, oppGoal, ownGoal } from '../src/sim/field.ts';
import { createMatch, simulate, step } from '../src/sim/match.ts';
import { awardRestart, issueCard, judgeFoul, matchMinute, matchSeconds } from '../src/sim/rules.ts';
import type { HumanInput, MatchPlayer, MatchState, RestartKind } from '../src/sim/types.ts';
import { add, dist, norm, scale, sub } from '../src/sim/vec.ts';
import { matchClock } from '../src/client/hud.ts';
import { kickOff } from './helpers.ts';

const MID = PITCH_H / 2;

/** Two ladder clubs, both in 4-4-2 so the scenes below can name a striker pair, wide men and centre-backs. */
function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  return { home: { ...cpuTeam(a, ladderSquad(a)), formation: '4-4-2' as const }, away: { ...cpuTeam(b, ladderSquad(b)), formation: '4-4-2' as const } };
}

/** Open play, the home side human-steered unless `cpu`. */
function live(seed = 5, cpu = false): MatchState {
  const s = createMatch({ seed, ...teams(7), halfSeconds: 120, humanTeam: cpu ? -1 : 0 });
  kickOff(s);
  s.ball.noPickup.fill(0);
  return s;
}

/** Everyone frozen and out of the way. */
function clearPitch(s: MatchState): void {
  s.players.forEach((p, k) => {
    p.stun = 100000;
    p.pos = { x: 30 + (k % 11) * 2, y: p.team === 0 ? 20 : 48 };
    p.vel = { x: 0, y: 0 };
  });
}

const player = (s: MatchState, team: 0 | 1, sub: MatchPlayer['sub'], nth = 0) => s.players.filter((p) => p.team === team && p.sub === sub && !p.sentOff)[nth]!;

function toReady(s: MatchState): void {
  for (let t = 0; t < 600 && s.restart && s.restart.stage !== 'ready'; t++) step(s, {});
}

const kinds = (s: MatchState, from: number) => s.events.slice(from).map((e) => (e.kind === 'restart' ? `restart:${e.restart}:${e.reason}` : e.kind));

describe('Law 8: the kick-off is a kick', () => {
  test('after the line-up the taker stands over the ball until he kicks it; pointing upfield does not dribble it', () => {
    const s = createMatch({ seed: 3, ...teams(7), halfSeconds: 120, humanTeam: 0 });
    const taker = s.players[s.controlled[0]];
    for (let t = 0; t < KICKOFF_PAUSE + RESTART_HUMAN_WAIT - 5; t++) step(s, { cursor: { x: 104, y: MID }, moved: true });
    expect(s.phase).toBe('restart');
    expect(s.restart!.kind).toBe('kickoff');
    expect(s.restart!.stage).toBe('ready');
    expect(s.ball.owner).toBe(taker.i);
    expect(dist(s.ball.pos, { x: PITCH_W / 2, y: MID })).toBeLessThan(0.01);
    // No kick yet, and the clock waits for it.
    expect(s.events.some((e) => e.kind === 'restartTaken')).toBe(false);
    expect(s.clock).toBe(0);
    // A click plays it like any restart.
    const mate = s.players.filter((p) => p.team === 0 && p.i !== taker.i && p.role !== 'GK').sort((a, b) => dist(a.pos, taker.pos) - dist(b.pos, taker.pos))[0];
    step(s, { cursor: mate.pos, aim: mate.pos, pass: true, moved: true });
    expect(s.phase).toBe('play');
    expect(s.ball.owner).toBe(-1);
    const taken = s.events.find((e) => e.kind === 'restartTaken')!;
    expect(taken.player).toBe(taker.i);
  });

  test('a human who never kicks it has the CPU take it, and every CPU kick-off is a pass', () => {
    const s = createMatch({ seed: 4, ...teams(7), halfSeconds: 120, humanTeam: 0 });
    let t = 0;
    while (s.phase !== 'play' && t++ < KICKOFF_PAUSE + RESTART_HUMAN_WAIT + 5) step(s, {});
    expect(s.phase).toBe('play');
    expect(t).toBeGreaterThanOrEqual(KICKOFF_PAUSE + RESTART_HUMAN_WAIT);
    expect(s.ball.owner).toBe(-1);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const m = createMatch({ seed, ...teams(seed), halfSeconds: 60, humanTeam: -1 });
      const taker = m.restart!.taker;
      while (m.phase !== 'play') step(m);
      expect(m.ball.owner).toBe(-1);
      expect(m.ball.lastTouch).toBe(taker);
      expect(len2(m.ball.vel)).toBeGreaterThan(2);
    }
  });

  test('second-half and after-goal kick-offs are kicks too; nobody moves until it is taken', () => {
    const s = createMatch({ seed: 9, ...teams(7), halfSeconds: 30, humanTeam: -1 });
    let kicks = 0;
    let frozenOk = true;
    while (s.phase !== 'fulltime') {
      const r = s.restart;
      const before = r?.kind === 'kickoff' && s.phase === 'restart' ? s.players.map((p) => ({ ...p.pos })) : null;
      step(s);
      if (before && s.phase === 'restart') s.players.forEach((p, i) => (frozenOk &&= p.sentOff || dist(p.pos, before[i]) < 1e-9));
      const e = s.events[s.events.length - 1];
      if (e?.kind === 'restartTaken' && e.restart === 'kickoff' && e.tick === s.tick) kicks++;
    }
    const kickoffs = s.events.filter((e) => e.kind === 'restart' && e.restart === 'kickoff').length;
    expect(kickoffs).toBeGreaterThanOrEqual(2);
    expect(kicks).toBe(kickoffs);
    expect(frozenOk).toBe(true);
  });
});

const len2 = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);

describe('Law 8: the teams change ends at half-time', () => {
  /** A CPU match run to the second-half kick-off line-up. */
  function secondHalf(seed = 2) {
    const s = createMatch({ seed, ...teams(7), halfSeconds: 20, humanTeam: -1 });
    const keepers1 = [0, 1].map((t) => s.players.find((p) => p.team === t && p.role === 'GK')!.pos.x);
    while (!(s.half === 2 && s.phase === 'kickoff')) step(s);
    return { s, keepers1 };
  }

  test('each side defends the other goal in the second half, and the other side kicks off', () => {
    const { s, keepers1 } = secondHalf();
    expect(keepers1[0]).toBeLessThan(5);
    expect(keepers1[1]).toBeGreaterThan(PITCH_W - 5);
    const gk = (t: 0 | 1) => s.players.find((p) => p.team === t && p.role === 'GK')!;
    expect(gk(0).pos.x).toBeGreaterThan(PITCH_W - 5);
    expect(gk(1).pos.x).toBeLessThan(5);
    expect(attackDir(s, 0)).toBe(-1);
    expect(ownGoal(s, 0).x).toBe(PITCH_W);
    expect(oppGoal(s, 1).x).toBe(PITCH_W);
    expect(s.restart!.team).toBe(1);
    // Everyone lined up in his own (new) half, facing the goal he now attacks.
    for (const p of s.players) {
      if (p.sentOff) continue;
      if (p.team === 0) expect(p.pos.x).toBeGreaterThanOrEqual(PITCH_W / 2 - 0.5);
      else expect(p.pos.x).toBeLessThanOrEqual(PITCH_W / 2 + 0.5);
      expect(Math.sign(p.facing.x)).toBe(attackDir(s, p.team));
    }
  });

  test('second half: a ball into the goal at x = 0 is a home goal; over that line off the away side, a goal kick to them', () => {
    const { s } = secondHalf(3);
    while (s.phase !== 'play') step(s);
    clearPitch(s);
    const home = player(s, 0, 'ST');
    const away = player(s, 1, 'CB');
    const b = s.ball;
    Object.assign(b, { owner: -1, receiver: -1, pos: { x: 6, y: MID }, vel: { x: -20, y: 0 }, z: 0, vz: 0, lastTouch: home.i, kickedBy: home.i, setPiece: null });
    const before = [...s.score];
    for (let t = 0; t < 60 && s.phase === 'play'; t++) step(s);
    expect(s.phase).toBe('goal');
    expect(s.score).toEqual([before[0] + 1, before[1]]);
    while (s.phase !== 'play') step(s);
    clearPitch(s);
    Object.assign(b, { owner: -1, receiver: -1, pos: { x: 4, y: 12 }, vel: { x: -14, y: 0 }, z: 0, vz: 0, lastTouch: home.i, kickedBy: home.i, setPiece: null });
    for (let t = 0; t < 60 && s.phase === 'play'; t++) step(s);
    expect(s.restart!.kind).toBe('goalkick');
    expect(s.restart!.team).toBe(1);
    expect(s.restart!.spot.x).toBeLessThan(6);
    while (s.restart?.kind === 'goalkick') step(s);
    clearPitch(s);
    Object.assign(b, { owner: -1, receiver: -1, pos: { x: 4, y: 12 }, vel: { x: -14, y: 0 }, z: 0, vz: 0, lastTouch: away.i, kickedBy: away.i, setPiece: null });
    for (let t = 0; t < 60 && s.phase === 'play'; t++) step(s);
    expect(s.restart!.kind).toBe('corner');
    expect(s.restart!.team).toBe(0);
  });

  test('a whole match plays the same either way round: CPU attacks the right goal in each half', () => {
    let shots1 = [0, 0];
    let shots2 = [0, 0];
    for (const seed of [11, 12, 13]) {
      const s = createMatch({ seed, ...teams(seed), halfSeconds: 90, humanTeam: -1 });
      while (s.phase !== 'fulltime') {
        const before = [s.stats[0].shots, s.stats[1].shots];
        step(s);
        for (const t of [0, 1] as const) {
          // A shot struck from right against a post can come straight back off it the same tick.
          const b = s.ball.pos;
          const atPost = [GOAL_TOP, GOAL_BOTTOM].some((y) => Math.hypot(Math.min(b.x, PITCH_W - b.x), b.y - y) < 0.5);
          if (s.stats[t].shots > before[t] && !atPost) {
            // The ball is heading for the goal this side attacks this half.
            expect(Math.sign(s.ball.vel.x)).toBe(attackDir(s, t));
            if (s.half === 1) shots1[t]++;
            else shots2[t]++;
          }
        }
      }
    }
    expect(shots1[0] + shots1[1]).toBeGreaterThan(5);
    expect(shots2[0] + shots2[1]).toBeGreaterThan(5);
  });
});

describe('Laws 8, 13-17: no second touch by the taker', () => {
  /** The human's side takes a restart of `kind` at `at`, tapped `tap` metres into space; everyone else is frozen. */
  function tapped(kind: RestartKind, at: { x: number; y: number }, tap: { x: number; y: number }) {
    const s = live(6);
    awardRestart(s, kind, 0, at, kind === 'freekick' ? 'foul' : 'out', true);
    toReady(s);
    const r = s.restart!;
    const taker = s.players[r.taker];
    for (const p of s.players) if (p.i !== taker.i) p.stun = 100000;
    const aim = add(r.spot, tap);
    step(s, { cursor: aim, aim, pass: true, moved: true });
    expect(s.phase).toBe('play');
    return { s, taker };
  }

  /** Steer the taker onto the ball until play stops. */
  function chase(s: MatchState, taker: MatchPlayer) {
    const ev0 = s.events.length;
    for (let t = 0; t < 400 && s.phase === 'play'; t++) {
      s.controlled[0] = taker.i;
      step(s, { cursor: add(s.ball.pos, scale(norm(s.ball.vel), 0.4)), moved: true });
    }
    return ev0;
  }

  for (const [kind, at, tap] of [
    ['freekick', { x: 60, y: 20 }, { x: 4, y: 0 }],
    ['throwin', { x: 60, y: -1 }, { x: 3, y: 2 }],
    ['corner', { x: PITCH_W + 1, y: -1 }, { x: -4, y: 2 }],
  ] as const) {
    test(`${kind}: playing it again before anyone else is an indirect free kick to the opponents where he did`, () => {
      const { s, taker } = tapped(kind, at, tap);
      const ev0 = chase(s, taker);
      expect(s.phase).toBe('restart');
      expect(s.restart!.kind).toBe('freekick');
      expect(s.restart!.team).toBe(1);
      expect(s.restart!.direct).toBe(false);
      expect(s.restart!.reason).toBe('second-touch');
      expect(kinds(s, ev0)).toContain('restart:freekick:second-touch');
    });
  }

  test('once anyone else has touched it, the taker may play it again', () => {
    const { s, taker } = tapped('freekick', { x: 60, y: 20 }, { x: 4, y: 0 });
    const opp = player(s, 1, 'CM');
    opp.stun = 0;
    opp.pos = add(s.ball.pos, scale(norm(s.ball.vel), 1.5));
    for (let t = 0; t < 60 && s.ball.lastTouch === taker.i; t++) step(s, {});
    expect(s.ball.lastTouch).toBe(opp.i);
    // Back at the taker's feet: his to play.
    s.ball.owner = -1;
    s.ball.pos = add(taker.pos, { x: 0.6, y: 0 });
    s.ball.vel = { x: -1, y: 0 };
    s.ball.noPickup.fill(0);
    taker.stun = 0;
    for (let t = 0; t < 30 && s.ball.owner !== taker.i && s.phase === 'play'; t++) {
      s.controlled[0] = taker.i;
      step(s, { cursor: s.ball.pos, moved: true });
    }
    expect(s.phase).toBe('play');
    expect(s.ball.owner).toBe(taker.i);
  });

  test('a CPU taker leaves it for someone else: no second-touch free kicks in CPU matches', () => {
    let secondTouches = 0;
    let restarts = 0;
    for (const seed of [21, 22, 23, 24, 25, 26]) {
      const s = simulate({ seed, ...teams(seed), halfSeconds: 120 });
      restarts += s.events.filter((e) => e.kind === 'restartTaken').length;
      secondTouches += s.events.filter((e) => e.kind === 'restart' && e.reason === 'second-touch').length;
    }
    expect(restarts).toBeGreaterThan(60);
    expect(secondTouches).toBe(0);
  });
});

describe('Law 12: a keeper may not handle his own goal kick or release', () => {
  test("a human's goal kick tapped into his area: the keeper does not pick it up again, someone else plays it", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = live(seed);
      awardRestart(s, 'goalkick', 0, { x: -1, y: seed % 2 ? MID - 8 : MID + 8 }, 'out', true);
      toReady(s);
      const r = s.restart!;
      const gk = s.players[r.taker];
      const aim = add(r.spot, { x: 4 + (seed % 5), y: 0 });
      step(s, { cursor: aim, aim, pass: true, moved: true });
      if (s.ball.receiver >= 0) continue; // the assist found a teammate
      const ev0 = s.events.length;
      let handled = false;
      for (let t = 0; t < 300 && s.phase === 'play' && s.ball.lastTouch === gk.i; t++) {
        step(s, { cursor: { x: 40, y: 30 }, moved: t < 10 });
        if (s.ball.owner === gk.i) handled = true;
      }
      expect(handled).toBe(false);
      expect(kinds(s, ev0)).not.toContain('restart:freekick:second-touch');
      expect(s.ball.lastTouch).not.toBe(gk.i);
    }
  });

  test("his own free kick coming straight back at him: he doesn't handle it, and the CPU keeper doesn't play it again", () => {
    const s = live(2);
    clearPitch(s);
    const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
    gk.stun = 0;
    gk.pos = { x: 8, y: MID };
    const b = s.ball;
    // His free kick in his area is played; it comes straight back off the post at him.
    b.restartBy = gk.i;
    b.noHands = gk.i;
    Object.assign(b, { owner: -1, receiver: -1, pos: { x: 9.5, y: MID }, vel: { x: -3, y: 0 }, z: 0, vz: 0, lastTouch: gk.i, kickedBy: gk.i, setPiece: 'freekick' });
    b.noPickup.fill(0);
    s.controlled[0] = gk.i;
    const ev0 = s.events.length;
    for (let t = 0; t < 60 && s.phase === 'play'; t++) step(s, {});
    expect(b.inHands).toBe(false);
    // The CPU keeper steps out of the way; it is nobody's offence.
    expect(kinds(s, ev0)).not.toContain('restart:freekick:second-touch');
  });

  test('the CPU keeper leaves his own goal kick alone', () => {
    let pickedUp = 0;
    let secondTouches = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = live(seed, true);
      awardRestart(s, 'goalkick', 0, { x: -1, y: MID + 8 }, 'out', true);
      toReady(s);
      const gk = s.players[s.restart!.taker];
      // Played short into space by the CPU keeper, everyone else still.
      s.restart!.ticks = s.restart!.wait;
      for (const p of s.players) if (p.i !== gk.i) p.stun = 100000;
      for (let t = 0; t < 5 && s.phase === 'restart'; t++) step(s);
      for (let t = 0; t < 200 && s.phase === 'play'; t++) {
        step(s);
        if (s.ball.owner === gk.i) pickedUp++;
      }
      secondTouches += s.events.filter((e) => e.kind === 'restart' && e.reason === 'second-touch').length;
    }
    expect(pickedUp).toBe(0);
    expect(secondTouches).toBe(0);
  });

  test('after rolling it out of his hands he may play it with his feet but not pick it up again until someone else touches it', () => {
    const s = live(3);
    clearPitch(s);
    const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
    gk.stun = 0;
    gk.pos = { x: 6, y: MID };
    const b = s.ball;
    b.owner = gk.i;
    b.inHands = true;
    b.lastTouch = gk.i;
    b.pos = { x: 6.9, y: MID };
    s.controlled[0] = gk.i;
    const aim = { x: 11, y: MID };
    step(s, { cursor: aim, aim, pass: true, moved: true });
    expect(b.owner).toBe(-1);
    let handled = false;
    let feet = false;
    for (let t = 0; t < 240 && s.phase === 'play'; t++) {
      s.controlled[0] = gk.i;
      step(s, { cursor: b.pos, moved: true });
      if (b.owner === gk.i && b.inHands) handled = true;
      if (b.owner === gk.i && !b.inHands) feet = true;
      if (feet) break;
    }
    expect(handled).toBe(false);
    expect(feet).toBe(true);
    expect(s.phase).toBe('play');
    // Someone else touches it: his hands are his again.
    const opp = player(s, 1, 'ST');
    b.owner = -1;
    b.lastTouch = opp.i;
    b.kickedBy = -1;
    b.pos = { x: 9, y: MID };
    b.vel = { x: -6, y: 0 };
    b.noPickup.fill(0);
    let caught = false;
    for (let t = 0; t < 60 && !caught; t++) {
      step(s, {});
      caught = b.owner === gk.i && b.inHands;
    }
    expect(caught).toBe(true);
  });
});

describe('Law 11: offside judged again when a teammate heads or deflects it on', () => {
  test('a flick-on header to a teammate who was offside at the header is offside', () => {
    let given = 0;
    let missed = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const s = live(seed, true);
      clearPitch(s);
      for (const [k, p] of s.players.filter((q) => q.team === 1).entries()) p.pos = p.role === 'GK' ? { x: PITCH_W - 0.5, y: MID - 12 } : { x: k < 3 ? 94 : 60, y: 10 + k * 4 };
      const crosser = player(s, 0, 'WM');
      const A = player(s, 0, 'ST', 0);
      const B = player(s, 0, 'ST', 1);
      A.stun = 0;
      A.pos = { x: 93, y: MID };
      B.pos = { x: 99, y: MID + 6 };
      const b = s.ball;
      Object.assign(b, { owner: -1, receiver: -1, pos: { x: 92.5, y: MID - 0.3 }, vel: { x: 1.5, y: 0.5 }, z: 2.2, vz: -1, lastTouch: crosser.i, kickedBy: crosser.i, setPiece: null });
      s.offside = null;
      const ev0 = s.events.length;
      let headed = false;
      for (let t = 0; t < 20 && s.phase === 'play'; t++) {
        step(s);
        if (b.lastTouch === A.i && b.owner < 0) {
          headed = true;
          break;
        }
      }
      if (!headed || !inOffsidePosition(s, B)) continue;
      B.pos = add(b.pos, scale(norm(b.vel), 1.2));
      B.stun = 0;
      for (let t = 0; t < 40 && s.phase === 'play' && b.lastTouch === A.i; t++) step(s);
      if (b.lastTouch !== B.i && !s.events.slice(ev0).some((e) => e.kind === 'offside')) continue;
      if (s.events.slice(ev0).some((e) => e.kind === 'offside' && e.player === B.i)) given++;
      else missed++;
    }
    expect(given).toBeGreaterThan(10);
    expect(missed).toBe(0);
  });

  test("a ball that comes off a teammate's body to a man in an offside position is offside; off an opponent it keeps the old judgement", () => {
    const s = live(4, true);
    clearPitch(s);
    const A = player(s, 0, 'ST', 0);
    const B = player(s, 0, 'ST', 1);
    const def = player(s, 1, 'CB', 0);
    const def2 = player(s, 1, 'CB', 1);
    def.pos = { x: 85, y: 20 };
    def2.pos = { x: 85, y: 50 };
    // A is onside where the ball hits him; B is beyond the line.
    A.pos = { x: 80, y: MID };
    B.pos = { x: 92, y: MID + 4 };
    A.stun = 0;
    B.stun = 0;
    const b = s.ball;
    const mate = player(s, 0, 'CM');
    Object.assign(b, { owner: -1, receiver: -1, pos: { x: 76, y: MID }, vel: { x: 14, y: 0 }, z: 1.0, vz: 0, lastTouch: mate.i, kickedBy: mate.i, setPiece: null });
    s.offside = null;
    for (let t = 0; t < 30 && b.lastTouch !== A.i; t++) step(s);
    expect(b.lastTouch).toBe(A.i);
    expect(s.offside?.players).toContain(B.i);
  });
});

describe("Law 12: a defender's header to his own keeper is no back-pass", () => {
  test('after a defensive header the keeper may still catch it', () => {
    let tried = 0;
    let caught = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = live(seed, true);
      clearPitch(s);
      const cb = player(s, 0, 'CB');
      const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
      const opp = player(s, 1, 'WM');
      cb.stun = 0;
      cb.pos = { x: 14, y: MID };
      gk.stun = 0;
      gk.pos = { x: 3, y: MID };
      const b = s.ball;
      Object.assign(b, { owner: -1, receiver: -1, pos: { x: 14.3, y: MID }, vel: { x: -1, y: 0 }, z: 2.0, vz: -0.5, lastTouch: opp.i, kickedBy: opp.i, setPiece: null });
      for (let t = 0; t < 6 && b.lastTouch !== cb.i; t++) step(s);
      if (b.lastTouch !== cb.i || b.owner >= 0) continue;
      tried++;
      expect(b.kickedBy).toBe(-1);
      // Wherever the header was going, send it back at the keeper (the header's state otherwise as it left).
      b.pos = { x: 10, y: MID };
      b.vel = { x: -9, y: 0 };
      b.z = 1.0;
      b.vz = 0;
      for (let t = 0; t < 90 && !(b.owner === gk.i) && s.phase === 'play'; t++) step(s);
      if (b.owner === gk.i && b.inHands) caught++;
    }
    expect(tried).toBeGreaterThan(5);
    expect(caught).toBe(tried);
  });
});

describe('Law 12: a late challenge after a shot', () => {
  /** A CPU striker has just shot from 22 m inside the post; the human's centre-back slides in on him. */
  function lateScene(seed: number, aim: { x: number; y: number }) {
    const s = live(seed);
    clearPitch(s);
    const st = player(s, 1, 'ST');
    st.stun = 0;
    st.pos = { x: 22, y: MID + 2 };
    st.facing = { x: -1, y: 0 };
    st.kickCd = 17;
    const cb = player(s, 0, 'CB');
    cb.stun = 0;
    cb.pos = { x: 21.2, y: MID + 2.6 };
    cb.vel = { x: 0, y: 0 };
    s.controlled[0] = cb.i;
    s.ctlHold = [false, false];
    s.referee.pos = { x: 30, y: MID + 10 };
    const b = s.ball;
    Object.assign(b, { owner: -1, receiver: -1, pos: { x: 21.3, y: MID + 2 }, z: 0, vz: 0, lastTouch: st.i, kickedBy: st.i, passFrom: -1, setPiece: null, redirectedAt: s.tick });
    b.vel = scale(norm(sub(aim, b.pos)), 26);
    const ev0 = s.events.length;
    step(s, { cursor: { ...st.pos }, tackle: true, moved: true });
    return { s, st, cb, ev0 };
  }

  test('a goal-bound shot is never cancelled: the goal stands and any card comes after, never for DOGSO', () => {
    let fouls = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const { s, cb, ev0 } = lateScene(seed, { x: 0, y: MID - 1.5 });
      const foul = s.events.slice(ev0).find((e) => e.kind === 'foul');
      expect(s.phase).toBe('play');
      if (!foul) continue;
      fouls++;
      expect(foul.kind === 'foul' && foul.advantage).toBe(true);
      for (let t = 0; t < 120 && s.phase === 'play'; t++) step(s, {});
      expect(s.phase).toBe('goal');
      const cards = s.cards.filter((c) => c.player === cb.i);
      for (const c of cards) expect(c.reason).not.toBe('dogso');
    }
    expect(fouls).toBeGreaterThan(15);
  });

  test('if the shot does not go in, the late challenge is given when it is over', () => {
    let given = 0;
    for (let seed = 1; seed <= 120 && given < 5; seed++) {
      // Just wide of the post: it goes out.
      const { s, ev0 } = lateScene(seed, { x: 0, y: MID - 5 });
      if (!s.events.slice(ev0).some((e) => e.kind === 'foul')) continue;
      for (let t = 0; t < 200 && s.phase === 'play'; t++) step(s, {});
      expect(s.phase).toBe('restart');
      expect(s.restart!.team).toBe(1);
      expect(s.restart!.reason).toBe('advantage');
      expect(['freekick', 'penalty']).toContain(s.restart!.kind);
      given++;
    }
    expect(given).toBe(5);
  });
});

describe('Law 12: advantage', () => {
  /** A foul on the away side's carrier in midfield with advantage played. */
  function advScene(seed: number) {
    for (let k = 0; k < 200; k++) {
      const s = live(seed * 1000 + k, true);
      const victim = player(s, 1, 'CM');
      const offender = player(s, 0, 'CM');
      s.ball.owner = victim.i;
      s.ball.lastTouch = victim.i;
      victim.pos = { x: 40, y: MID };
      s.ball.pos = { x: 39.2, y: MID };
      s.referee.pos = { x: 45, y: MID + 8 };
      judgeFoul(s, { offender, victim, severity: 'careless', attempt: true, keptBall: true });
      if (s.advantage) return { s, victim, offender };
    }
    throw new Error('no advantage');
  }

  test('brought back when the fouled side loses the ball at once: a free kick, reason advantage', () => {
    const { s } = advScene(1);
    const spot = { ...s.advantage!.spot };
    const thief = player(s, 0, 'ST');
    s.ball.owner = thief.i;
    s.ball.lastTouch = thief.i;
    step(s);
    expect(s.phase).toBe('restart');
    expect(s.restart!.kind).toBe('freekick');
    expect(s.restart!.team).toBe(1);
    expect(s.restart!.reason).toBe('advantage');
    expect(dist(s.restart!.spot, spot)).toBeLessThan(0.5);
  });

  test('not brought back once the fouled side has had a shot or completed a pass', () => {
    for (const what of ['shot', 'pass'] as const) {
      const { s } = advScene(2);
      if (what === 'shot') s.stats[1].shots++;
      else s.stats[1].passes++;
      step(s);
      expect(s.advantage).toBe(null);
      const thief = player(s, 0, 'ST');
      s.ball.owner = thief.i;
      s.ball.lastTouch = thief.i;
      step(s);
      expect(s.phase).toBe('play');
    }
  });
});

describe('Law 7: added time', () => {
  test('the board goes up at 45:00, the clock holds while it is played, then half-time', () => {
    const s = createMatch({ seed: 2, ...teams(7), halfSeconds: 30, humanTeam: -1 });
    for (let t = 0; t < 20000 && !s.events.some((e) => e.kind === 'addedTime'); t++) step(s);
    const board = s.events.find((e) => e.kind === 'addedTime')!;
    expect(board.kind === 'addedTime' && board.minutes).toBeGreaterThanOrEqual(1);
    expect(matchSeconds(s)).toBe(2700);
    expect(matchMinute(s)).toBe(45);
    const minutes = s.added!.minutes;
    expect(matchClock(s)).toBe(`45:00 +${minutes}`);
    const at = s.tick;
    for (let t = 0; t < 20000 && s.phase !== 'halftime'; t++) step(s);
    // Played in full: the minutes on the board (45 match minutes are halfTicks), and the clock held.
    expect(s.tick - at).toBeGreaterThanOrEqual(Math.round((minutes * s.halfTicks) / 45));
    expect(matchSeconds(s)).toBe(2700);
    const ht = s.events.find((e) => e.kind === 'halftime')!;
    expect(ht.minute).toBe(45);
  });

  test('more stoppages, more added time', () => {
    const s = createMatch({ seed: 2, ...teams(7), halfSeconds: 30, humanTeam: -1 });
    const quiet = createMatch({ seed: 2, ...teams(7), halfSeconds: 30, humanTeam: -1 });
    for (let k = 0; k < 6; k++) issueCard(s, s.players[2 + (k % 4)], 'yellow', 'reckless');
    s.players.forEach((p) => (p.yellow = 0));
    for (const m of [s, quiet]) for (let t = 0; t < 20000 && !m.events.some((e) => e.kind === 'addedTime'); t++) step(m);
    expect(s.added!.minutes).toBeGreaterThan(quiet.added!.minutes);
  });

  test('the whistle waits for a shot already on its way to goal', () => {
    let goals = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = createMatch({ seed, ...teams(7), halfSeconds: 30, humanTeam: -1 });
      while (!(s.added && s.added.elapsed >= s.added.ticks - 1) && s.phase !== 'halftime') step(s);
      if (s.phase !== 'play') continue;
      // A shot from 25 m, keeper and defenders frozen: it is in flight when time is up.
      clearPitch(s);
      const st = player(s, 0, 'ST');
      const b = s.ball;
      Object.assign(b, { owner: -1, receiver: -1, pos: { x: PITCH_W - 25, y: MID }, vel: { x: 22, y: 0 }, z: 0, vz: 0, lastTouch: st.i, kickedBy: st.i, setPiece: null });
      const g0 = s.goals.length;
      while (s.phase === 'play') step(s);
      expect(s.goals.length).toBe(g0 + 1);
      goals++;
    }
    expect(goals).toBeGreaterThan(2);
  });
});

describe('Law 3: fewer than seven players', () => {
  test('a fifth red card abandons the match, awarded 3-0 against that side', () => {
    const s = live(5, true);
    const home = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
    for (let k = 0; k < 4; k++) issueCard(s, home[k], 'red', 'excessive');
    expect(s.phase).toBe('play');
    issueCard(s, home[4], 'red', 'excessive');
    expect(s.phase).toBe('fulltime');
    expect(s.abandoned?.team).toBe(0);
    expect(s.score).toEqual([0, 3]);
    expect(s.events.some((e) => e.kind === 'abandoned' && e.team === 0)).toBe(true);
    expect(s.events[s.events.length - 1].kind).toBe('fulltime');
    // Nothing more happens, and stepping on is harmless.
    const n = s.events.length;
    for (let t = 0; t < 50; t++) step(s);
    expect(s.events.length).toBe(n);
  });

  test('a side already three or more up keeps its score', () => {
    const s = live(5, true);
    s.score = [0, 4];
    const home = s.players.filter((p) => p.team === 0 && p.role !== 'GK');
    for (let k = 0; k < 5; k++) issueCard(s, home[k], 'red', 'excessive');
    expect(s.score).toEqual([0, 4]);
  });

  test('a red card in a foul that leaves six never restarts play, and sending off everyone never throws', () => {
    const s = live(5, true);
    const home = s.players.filter((p) => p.team === 0);
    for (let k = 0; k < 4; k++) issueCard(s, home[k + 1], 'red', 'excessive');
    const victim = player(s, 1, 'CM');
    s.ball.owner = victim.i;
    judgeFoul(s, { offender: home[5], victim, severity: 'excessive', attempt: false, keptBall: false });
    // The rolls may wave it away; force the red if so.
    if (!home[5].sentOff) issueCard(s, home[5], 'red', 'excessive');
    expect(s.phase).toBe('fulltime');
    expect(s.restart).toBe(null);
    expect(() => {
      for (const p of s.players) issueCard(s, p, 'red', 'excessive');
      for (let t = 0; t < 30; t++) step(s, {} as HumanInput);
    }).not.toThrow();
  });
});
