// The Laws of the Game in the sim: restarts (Laws 8, 13-17), offside (Law 11),
// fouls and misconduct (Law 12), the referee, and eleven-a-side balance.

import { describe, expect, test } from 'bun:test';
import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { decodeReplay, encodeReplay, ReplaySeeker, type Replay } from '../src/meta/replay.ts';
import { BOX_DEPTH, BOX_W, GOAL_W, PENALTY_SPOT, PITCH_H, PITCH_W, RETREAT, SIM_VERSION, TEAM_SIZE } from '../src/sim/constants.ts';
import { inOffsidePosition, inOwnBox, secondLastOpponentX } from '../src/sim/field.ts';
import { createMatch, fingerprint, matchSeconds, simulate, step } from '../src/sim/match.ts';
import { awardRestart, issueCard, judgeFoul, noteBallPlayed, offsideOnTouch, OFF_PITCH } from '../src/sim/rules.ts';
import type { HumanInput, MatchPlayer, MatchState, RestartKind } from '../src/sim/types.ts';
import { dist } from '../src/sim/vec.ts';
import { kickOff } from './helpers.ts';

const MID = PITCH_H / 2;

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  return { home: cpuTeam(a, ladderSquad(a)), away: cpuTeam(b, ladderSquad(b)) };
}

/** A match in open play, home side human-steered unless `cpu`. */
function live(seed = 5, cpu = false): MatchState {
  const s = createMatch({ seed, ...teams(7), halfSeconds: 120, humanTeam: cpu ? -1 : 0 });
  kickOff(s);
  return s;
}

/** Everyone frozen and out of the way, so a test ball goes where it is sent. */
function clearPitch(s: MatchState): void {
  s.players.forEach((p, k) => {
    p.stun = 100000;
    p.pos = { x: 30 + (k % 11) * 2, y: p.team === 0 ? 20 : 48 };
    p.vel = { x: 0, y: 0 };
  });
}

/** Send a loose ball from `from` with velocity v, last touched by player `by`; step until play stops. */
function roll(s: MatchState, from: { x: number; y: number }, v: { x: number; y: number }, by: number, z = 0): void {
  const b = s.ball;
  b.owner = -1;
  b.receiver = -1;
  b.pos = { ...from };
  b.vel = { ...v };
  b.z = z;
  b.vz = 0;
  b.lastTouch = by;
  b.kickedBy = by;
  b.setPiece = null;
  for (let t = 0; t < 400 && s.phase === 'play'; t++) step(s);
}

const player = (s: MatchState, team: 0 | 1, sub: MatchPlayer['sub']) => s.players.find((p) => p.team === team && p.sub === sub && !p.sentOff)!;

/** Step a restart through to 'ready' (the taker over the ball) without anyone acting. */
function toReady(s: MatchState): void {
  for (let t = 0; t < 600 && s.restart && s.restart.stage !== 'ready'; t++) step(s, {});
}

describe('restarts: out of play over each line', () => {
  test('over a touchline: a throw-in to the other side, on the line where it went out', () => {
    for (const [y, vy] of [[3, -12], [PITCH_H - 3, 12]] as const) {
      const s = live();
      clearPitch(s);
      const home = player(s, 0, 'CM');
      roll(s, { x: 40, y }, { x: 0, y: vy }, home.i);
      expect(s.phase).toBe('restart');
      expect(s.restart!.kind).toBe('throwin');
      expect(s.restart!.team).toBe(1);
      expect(s.restart!.spot.y).toBe(vy < 0 ? 0 : PITCH_H);
      expect(Math.abs(s.restart!.spot.x - 40)).toBeLessThan(1);
      expect(s.restart!.direct).toBe(false);
    }
  });

  test('over a goal line: a corner if the defenders put it out, a goal kick if the attackers did', () => {
    for (const side of [0, 1] as const) {
      const lineX = side === 0 ? 0 : PITCH_W;
      const dir = side === 0 ? -1 : 1;
      const defending = side;
      const attacking: 0 | 1 = side === 0 ? 1 : 0;
      // Attacker's shot wide of the post: goal kick to the defending side, in its goal area.
      const s = live();
      clearPitch(s);
      roll(s, { x: lineX - dir * 10, y: MID + GOAL_W }, { x: dir * 20, y: 0 }, player(s, attacking, 'ST').i);
      expect(s.restart!.kind).toBe('goalkick');
      expect(s.restart!.team).toBe(defending);
      expect(inOwnBox(s, defending, s.restart!.spot)).toBe(true);
      expect(Math.abs(s.restart!.spot.x - lineX)).toBeLessThan(5.5);
      // A defender's touch over his own line: corner to the attackers, from the corner arc on that side.
      const c = live();
      clearPitch(c);
      roll(c, { x: lineX - dir * 6, y: 8 }, { x: dir * 15, y: -2 }, player(c, defending, 'CB').i);
      expect(c.restart!.kind).toBe('corner');
      expect(c.restart!.team).toBe(attacking);
      expect(Math.abs(c.restart!.spot.x - lineX)).toBeLessThan(1);
      expect(c.restart!.spot.y).toBeLessThan(1);
    }
  });

  test('over the bar is out of play too, not a goal', () => {
    const s = live();
    clearPitch(s);
    roll(s, { x: PITCH_W - 4, y: MID }, { x: 20, y: 0 }, player(s, 0, 'ST').i, 3.5);
    expect(s.score).toEqual([0, 0]);
    expect(s.restart!.kind).toBe('goalkick');
  });

  test('a restart freezes play, positions players legally and is taken by the chosen taker', () => {
    const cases: [RestartKind, 0 | 1, { x: number; y: number }][] = [
      ['corner', 0, { x: PITCH_W + 1, y: -1 }],
      ['freekick', 0, { x: PITCH_W - 24, y: MID + 3 }],
      ['goalkick', 1, { x: PITCH_W + 1, y: MID + 8 }],
      ['penalty', 0, { x: PITCH_W - 9, y: MID }],
      ['throwin', 1, { x: 50, y: -1 }],
    ];
    for (const [kind, team, at] of cases) {
      const s = live(9, true);
      awardRestart(s, kind, team, at, 'foul', true);
      const tickBefore = s.tick;
      toReady(s);
      const r = s.restart!;
      expect(r.stage).toBe('ready');
      expect(s.ball.owner).toBe(r.taker);
      expect(s.players[r.taker].team).toBe(team);
      if (kind === 'goalkick') expect(s.players[r.taker].role).toBe('GK');
      expect(dist(s.ball.pos, r.spot)).toBeLessThan(1e-9);
      for (const p of s.players) {
        if (p.sentOff || p.i === r.taker) continue;
        const opp = p.team !== team;
        if (kind === 'corner' || kind === 'freekick') if (opp) expect(dist(p.pos, r.spot)).toBeGreaterThanOrEqual(RETREAT - 1e-6);
        if (kind === 'goalkick' && opp) expect(inOwnBox(s, team, p.pos)).toBe(false);
        if (kind === 'throwin' && opp) expect(dist(p.pos, r.spot)).toBeGreaterThanOrEqual(2 - 1e-6);
        if (kind === 'penalty') {
          const keeper = p.role === 'GK' && opp;
          if (keeper) expect(Math.abs(p.pos.x - PITCH_W)).toBeLessThan(0.5);
          else {
            expect(inOwnBox(s, 1, p.pos)).toBe(false);
            expect(dist(p.pos, r.spot)).toBeGreaterThanOrEqual(RETREAT - 1e-6);
          }
        }
      }
      // The CPU taker plays it, and play resumes.
      for (let t = 0; t < 200 && s.phase === 'restart'; t++) step(s, {});
      expect(s.phase).not.toBe('restart');
      expect(s.tick - tickBefore).toBeLessThan(500);
      const taken = s.events.filter((e) => e.kind === 'restartTaken');
      expect(taken.at(-1)).toMatchObject({ kind: 'restartTaken', restart: kind, team, player: r.taker });
    }
  });

  test('penalty spot is 11 m out, the goal kick inside the goal area, the corner on the arc', () => {
    const s = live(3, true);
    awardRestart(s, 'penalty', 0, { x: 100, y: 30 }, 'foul');
    expect(s.restart!.spot).toEqual({ x: PITCH_W - PENALTY_SPOT, y: MID });
    expect(BOX_DEPTH).toBe(16.5);
  });

  test('a human taker plays the restart with an ordinary pass; the clock stops until the ball is in play', () => {
    const s = live(4);
    awardRestart(s, 'throwin', 0, { x: 50, y: -1 }, 'out');
    const stopped = s.clock;
    toReady(s);
    expect(s.clock).toBe(stopped);
    const r = s.restart!;
    expect(s.controlled[0]).toBe(r.taker);
    const mate = s.players.filter((p) => p.team === 0 && p.i !== r.taker && p.role !== 'GK').sort((a, b) => dist(a.pos, r.spot) - dist(b.pos, r.spot))[0];
    const clock = s.clock;
    step(s, { cursor: mate.pos, pass: true });
    expect(s.phase).toBe('play');
    expect(s.clock).toBe(clock);
    step(s, {});
    expect(s.clock).toBe(clock + 1);
    expect(s.ball.setPiece).toBe('throwin');
    expect(s.ball.z).toBeGreaterThan(1.5); // from the hands
    expect(s.ball.receiver).toBe(mate.i);
  });

  test('a human who does nothing has the throw taken for him after a few seconds', () => {
    const s = live(4);
    awardRestart(s, 'throwin', 0, { x: 50, y: -1 }, 'out');
    let n = 0;
    while (s.phase === 'restart' && n++ < 1000) step(s, {});
    expect(s.phase).toBe('play');
    expect(n).toBeLessThan(700);
  });
});

describe('what can score straight from a restart', () => {
  /** Take a restart with a human shot, then send the ball straight into the net untouched. */
  function straightIn(kind: RestartKind): MatchState {
    const s = live(6);
    awardRestart(s, kind, 0, kind === 'corner' ? { x: PITCH_W + 1, y: -1 } : { x: 80, y: -1 }, 'out');
    toReady(s);
    const taker = s.players[s.restart!.taker];
    expect(s.controlled[0]).toBe(taker.i);
    step(s, { cursor: { x: PITCH_W, y: MID }, shoot: 1 });
    expect(s.phase).toBe('play');
    expect(s.ball.setPiece).toBe(kind);
    for (const p of s.players) p.stun = 100000;
    const b = s.ball;
    b.pos = { x: PITCH_W - 3, y: MID };
    b.vel = { x: 25, y: 0 };
    b.z = 0.5;
    b.vz = 0;
    for (let t = 0; t < 120 && s.phase === 'play'; t++) step(s);
    return s;
  }

  test('a corner kick can go straight in', () => {
    const s = straightIn('corner');
    expect(s.phase).toBe('goal');
    expect(s.score).toEqual([1, 0]);
    expect(s.goals.at(-1)).toMatchObject({ kind: 'goal', team: 0, from: 'corner' });
  });

  test('a throw-in cannot: thrown straight in, it is a goal kick', () => {
    const s = straightIn('throwin');
    expect(s.score).toEqual([0, 0]);
    expect(s.restart!.kind).toBe('goalkick');
    expect(s.restart!.team).toBe(1);
  });
});

describe('offside (Law 11)', () => {
  /** Team 0 attacking: two defenders at x = lineX, keeper on his line, an attacker at x, the ball at bx. */
  function setup(x: number, lineX: number, bx: number) {
    const s = live(2, true);
    clearPitch(s);
    const opp = s.players.filter((p) => p.team === 1);
    opp.forEach((p, k) => (p.pos = p.role === 'GK' ? { x: PITCH_W - 1, y: MID } : { x: k < 3 ? lineX : 20, y: 10 + k * 4 }));
    const att = player(s, 0, 'ST');
    att.pos = { x, y: MID };
    const passer = player(s, 0, 'CM');
    passer.pos = { x: bx - 1, y: MID - 10 };
    s.ball.owner = passer.i;
    s.ball.pos = { x: bx, y: MID - 10 };
    return { s, att, passer };
  }

  test('beyond the second-last defender and the ball, in their half: offside position', () => {
    const { s, att } = setup(85, 80, 60);
    expect(secondLastOpponentX(s, 0)).toBeCloseTo(80 / PITCH_W, 9);
    expect(inOffsidePosition(s, att)).toBe(true);
  });

  test('level with the second-last defender is onside', () => {
    const { s, att } = setup(80, 80, 60);
    expect(inOffsidePosition(s, att)).toBe(false);
  });

  test('in his own half he is onside, however deep the defenders', () => {
    const { s, att } = setup(PITCH_W / 2 - 1, 40, 30);
    expect(inOffsidePosition(s, att)).toBe(false);
  });

  test('behind the ball is onside', () => {
    const { s, att } = setup(85, 80, 88);
    expect(inOffsidePosition(s, att)).toBe(false);
  });

  test('involved: receiving the pass is an offence, an indirect free kick where he touched it, and the flag goes up', () => {
    const { s, att, passer } = setup(85, 80, 60);
    noteBallPlayed(s, passer);
    expect(s.offside?.players).toContain(att.i);
    s.ball.owner = -1;
    expect(offsideOnTouch(s, att, true)).toBe(true);
    expect(s.restart).toMatchObject({ kind: 'freekick', team: 1, direct: false, reason: 'offside' });
    expect(s.restart!.spot.x).toBeCloseTo(85, 5);
    expect(s.events.some((e) => e.kind === 'offside' && e.player === att.i && e.team === 0)).toBe(true);
    expect(s.stats[0].offsides).toBe(1);
  });

  test('passive: an onside teammate playing it means no offence', () => {
    const { s, att, passer } = setup(85, 80, 60);
    noteBallPlayed(s, passer);
    // Any onside teammate (CPU clubs line up in several formations, not all with wide midfielders).
    const onside = s.players.find((p) => p.team === 0 && p.role === 'MID' && p.i !== passer.i)!;
    onside.pos = { x: 70, y: 20 };
    expect(offsideOnTouch(s, onside, true)).toBe(false);
    expect(s.offside).toBeNull();
    expect(offsideOnTouch(s, att, true)).toBe(false); // the old judgement is gone
    expect(s.phase).toBe('play');
  });

  test('a defender playing the ball resets it', () => {
    const { s, att, passer } = setup(85, 80, 60);
    noteBallPlayed(s, passer);
    expect(offsideOnTouch(s, player(s, 1, 'CB'), true)).toBe(false);
    expect(offsideOnTouch(s, att, true)).toBe(false);
  });

  test('no offside from a throw-in', () => {
    const s = live(8);
    clearPitch(s);
    for (const p of s.players) p.stun = 0;
    awardRestart(s, 'throwin', 0, { x: 85, y: -1 }, 'out');
    toReady(s);
    // Put a teammate well beyond the defence, then throw it to him.
    const r = s.restart!;
    const runner = s.players.find((p) => p.team === 0 && p.i !== r.taker && p.role === 'FWD')!;
    for (const p of s.players) if (p.team === 1 && p.role !== 'GK') p.pos = { x: 60, y: 30 + p.slot };
    runner.pos = { x: 95, y: 8 };
    step(s, { cursor: runner.pos, pass: true });
    expect(s.phase).toBe('play');
    expect(s.offside).toBeNull();
    for (let t = 0; t < 200 && s.ball.owner !== runner.i && s.phase === 'play'; t++) step(s, {});
    expect(s.events.some((e) => e.kind === 'offside')).toBe(false);
  });
});

describe('fouls and misconduct (Law 12)', () => {
  /** A foul by `off` on `victim` at `at`; the referee right there. Tries seeds until it is given. */
  function foul(at: { x: number; y: number }, severity: 'careless' | 'reckless' | 'excessive', extra?: (s: MatchState) => void) {
    for (let seed = 1; seed < 50; seed++) {
      const s = live(seed, true);
      clearPitch(s);
      const victim = player(s, 0, 'ST');
      const off = player(s, 1, 'CB');
      victim.pos = { ...at };
      victim.vel = { x: 6, y: 0 };
      victim.facing = { x: 1, y: 0 };
      off.pos = { x: at.x - 1, y: at.y + 0.5 };
      s.ball.owner = victim.i;
      s.referee.pos = { x: at.x - 8, y: at.y + 6 };
      extra?.(s);
      if (judgeFoul(s, { offender: off, victim, severity, attempt: true, keptBall: false })) return { s, victim, off };
    }
    throw new Error('never given');
  }

  test('a foul in the offender\'s penalty area is a penalty; outside, a direct free kick', () => {
    const inBox = foul({ x: PITCH_W - 10, y: MID + 4 }, 'careless');
    expect(inBox.s.restart).toMatchObject({ kind: 'penalty', team: 0 });
    const out = foul({ x: 60, y: 20 }, 'careless');
    expect(out.s.restart).toMatchObject({ kind: 'freekick', team: 0, direct: true });
    expect(out.s.events.some((e) => e.kind === 'foul' && e.player === out.off.i && !e.penalty)).toBe(true);
  });

  test('DOGSO outside the area: a red card, and the offender leaves the pitch', () => {
    let reds = 0;
    for (let k = 0; k < 10; k++) {
      // Through on goal, 22 m out, nobody but the keeper goal-side.
      const { s, off } = foul({ x: PITCH_W - 22 + k * 0.1, y: MID }, 'careless');
      const cards = s.cards.filter((c) => c.player === off.i);
      expect(cards.length).toBe(1);
      expect(cards[0].reason).toBe('dogso');
      if (cards[0].color === 'red') {
        reds++;
        expect(off.sentOff).toBe(true);
      }
    }
    expect(reds).toBeGreaterThanOrEqual(7);
  });

  test('DOGSO in the area with a genuine attempt at the ball: penalty and a yellow, not a red', () => {
    const { s, off } = foul({ x: PITCH_W - 9, y: MID }, 'careless');
    expect(s.restart!.kind).toBe('penalty');
    expect(s.cards.filter((c) => c.player === off.i).map((c) => [c.color, c.reason])).toEqual([['yellow', 'dogso']]);
    expect(off.sentOff).toBe(false);
  });

  test('excessive force is a red card', () => {
    const { s, off } = foul({ x: 40, y: 20 }, 'excessive');
    const cards = s.cards.filter((c) => c.player === off.i);
    expect(cards.length).toBe(1);
  });

  test('a second yellow is a red: the player leaves and his team plays a man short', () => {
    const s = live(3, true);
    const p = player(s, 1, 'DM');
    issueCard(s, p, 'yellow', 'reckless');
    expect(p.yellow).toBe(1);
    expect(p.sentOff).toBe(false);
    issueCard(s, p, 'yellow', 'spa');
    expect(p.sentOff).toBe(true);
    const mine = s.cards.filter((c) => c.player === p.i).map((c) => [c.color, c.secondYellow]);
    expect(mine).toEqual([['yellow', false], ['yellow', true], ['red', true]]);
    expect(s.events.some((e) => e.kind === 'sentOff' && e.player === p.i)).toBe(true);
    expect(p.pos).toEqual(OFF_PITCH);
    for (let t = 0; t < 1200; t++) {
      step(s);
      expect(p.pos).toEqual(OFF_PITCH);
      expect(s.ball.owner).not.toBe(p.i);
    }
    expect(s.players.filter((q) => q.team === 1 && !q.sentOff).length).toBe(TEAM_SIZE - 1);
  });

  test('a keeper sent off is replaced in goal by an outfielder', () => {
    const s = live(3, true);
    const gk = player(s, 0, 'GK');
    issueCard(s, gk, 'red', 'dogso');
    const keepers = s.players.filter((p) => p.team === 0 && p.role === 'GK' && !p.sentOff);
    expect(keepers.length).toBe(1);
    expect(keepers[0].i).not.toBe(gk.i);
  });

  test('advantage: the fouled side keeps the ball and play goes on; losing it brings the free kick back', () => {
    let seen = false;
    for (let seed = 1; seed < 60 && !seen; seed++) {
      const s = live(seed, true);
      clearPitch(s);
      const victim = player(s, 0, 'ST');
      const off = player(s, 1, 'CB');
      victim.pos = { x: 70, y: 20 };
      s.ball.owner = victim.i;
      s.referee.pos = { x: 62, y: 26 };
      const stopped = judgeFoul(s, { offender: off, victim, severity: 'careless', attempt: true, keptBall: true });
      if (stopped || !s.advantage) continue;
      seen = true;
      expect(s.phase).toBe('play');
      expect(s.events.some((e) => e.kind === 'advantage')).toBe(true);
      // The defenders win it straight back: the referee brings it back for the free kick.
      s.ball.owner = off.i;
      step(s);
      expect(s.restart).toMatchObject({ kind: 'freekick', team: 0 });
    }
    expect(seen).toBe(true);
  });
});

describe('the referee and the event stream', () => {
  test('the referee follows play and stays on the pitch', () => {
    const s = createMatch({ seed: 12, ...teams(3), halfSeconds: 30, humanTeam: -1 });
    let near = 0;
    let n = 0;
    while (s.phase !== 'fulltime') {
      step(s);
      const r = s.referee.pos;
      expect(r.x >= 0 && r.x <= PITCH_W && r.y >= 0 && r.y <= PITCH_H).toBe(true);
      if (s.phase === 'play') {
        n++;
        if (dist(r, s.ball.pos) < 30) near++;
      }
    }
    expect(near / n).toBeGreaterThan(0.85);
  });

  test('every event has a tick, a team, a player field and the clock; goals and cards are mirrored', () => {
    const s = simulate({ seed: 21, ...teams(4), halfSeconds: 90 });
    const kinds = new Set(s.events.map((e) => e.kind));
    for (const k of ['restart', 'restartTaken', 'halftime', 'fulltime']) expect(kinds.has(k as never)).toBe(true);
    let last = 0;
    for (const e of s.events) {
      expect(e.tick).toBeGreaterThanOrEqual(last);
      last = e.tick;
      expect([0, 1]).toContain(e.team);
      expect(typeof e.player).toBe('number');
      expect(e.second).toBeGreaterThanOrEqual(0);
      expect(e.second).toBeLessThanOrEqual(5400);
    }
    expect(s.goals).toEqual(s.events.filter((e) => e.kind === 'goal') as never);
    expect(s.cards).toEqual(s.events.filter((e) => e.kind === 'card') as never);
    expect(matchSeconds(s)).toBe(5400);
  });
});

describe('determinism with restarts', () => {
  test('two runs of the same match are identical, restarts, fouls and cards included', () => {
    const run = () => simulate({ seed: 77, ...teams(5), halfSeconds: 60 });
    const a = run();
    const b = run();
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.events.filter((e) => e.kind === 'restart').length).toBeGreaterThan(3);
  });

  test('a state cloned in the middle of a restart carries on identically', () => {
    const s = createMatch({ seed: 31, ...teams(6), halfSeconds: 60, humanTeam: -1 });
    while (s.phase !== 'restart' || s.restart!.stage !== 'setup') step(s);
    const copy = structuredClone(s) as MatchState;
    for (let t = 0; t < 1500; t++) {
      step(s);
      step(copy);
    }
    expect(fingerprint(copy)).toBe(fingerprint(s));
  });

  test('a six-a-side replay (format 2) still opens, plays, and is flagged as from another version', () => {
    // Build a format-3 code, then rewrite it as format 2 would have been: no sim version, no formation, six players.
    const t = teams(2);
    const six = (x: typeof t.home) => ({ ...x, formation: undefined, players: x.players.slice(0, 6) });
    const r: Replay = { seed: 4, halfSeconds: 5, humanTeam: 0, home: six(t.home), away: six(t.away), ticks: 600, runs: [{ n: 600, input: {} as HumanInput }], goals: [], score: [0, 0], fp: 12345, label: 'Old', at: 1, sim: 1 };
    const back = decodeReplay(encodeReplay(r));
    expect(back.sim).toBe(1);
    expect(back.home.players.length).toBe(6);
    const seeker = new ReplaySeeker(back);
    while (!seeker.warm(5000));
    expect(seeker.verified).toBe(false);
    expect(seeker.state.players.length).toBe(TEAM_SIZE * 2);
    expect(SIM_VERSION).toBeGreaterThan(1);
  });

  test('a replay recorded on the previous sim version opens but is flagged, not verified', () => {
    const t = teams(2);
    const r: Replay = { seed: 4, halfSeconds: 5, humanTeam: 0, home: t.home, away: t.away, ticks: 600, runs: [{ n: 600, input: {} as HumanInput }], goals: [], score: [0, 0], fp: 12345, label: 'Prev', at: 1, sim: SIM_VERSION - 1 };
    const back = decodeReplay(encodeReplay(r));
    expect(back.sim).toBe(SIM_VERSION - 1);
    const seeker = new ReplaySeeker(back);
    while (!seeker.warm(5000));
    expect(seeker.verified).toBe(false);
  });
});

describe('eleven-a-side balance', () => {
  test(
    'goals, fouls, cards, corners and offsides per match are in realistic-ish ranges, and a match is quick',
    () => {
      // From three ladders, as scripts/balance.ts does: one ladder's mix of deep and attacking clubs swings goals a lot.
      const ladders = [2026, 2027, 2028].map((seed) => generateLadder(seed, 16));
      const n = 9;
      const tot = { goals: 0, fouls: 0, yellows: 0, reds: 0, corners: 0, offsides: 0, ms: 0 };
      for (let i = 0; i < n; i++) {
        const clubs = ladders[i % 3];
        const j = Math.floor(i / 3);
        const a = clubs[j % 16];
        const b = clubs[(j * 7 + 3) % 16];
        const t0 = performance.now();
        const s = simulate({ seed: 100 + i, home: cpuTeam(a, ladderSquad(a)), away: cpuTeam(b, ladderSquad(b)) });
        tot.ms += performance.now() - t0;
        tot.goals += s.score[0] + s.score[1];
        for (const k of ['fouls', 'yellows', 'reds', 'corners', 'offsides'] as const) tot[k] += s.stats[0][k] + s.stats[1][k];
        expect(s.players.length).toBe(22);
      }
      const per = (v: number) => v / n;
      expect(per(tot.goals)).toBeGreaterThan(1);
      expect(per(tot.goals)).toBeLessThan(5.5);
      // Six minutes of play, not ninety: about 3-5 fouls and under a yellow a match (a real 90 minutes
      // is ~22 and ~3.5, so the CPU used to foul and book several times too often for the length).
      expect(per(tot.fouls)).toBeGreaterThan(1.5);
      expect(per(tot.fouls)).toBeLessThan(12);
      expect(per(tot.yellows)).toBeGreaterThan(0.05);
      expect(per(tot.yellows)).toBeLessThan(4);
      expect(per(tot.reds)).toBeLessThan(1);
      expect(per(tot.corners)).toBeGreaterThan(0.5);
      expect(per(tot.offsides)).toBeGreaterThan(0.2);
      expect(per(tot.ms)).toBeLessThan(1500); // well under a second normally; slack for slow CI
    },
    { timeout: 30_000 },
  );

  test('box geometry: the penalty area is 40.32 m wide', () => {
    expect(BOX_W).toBeCloseTo(40.32, 6);
  });
});
