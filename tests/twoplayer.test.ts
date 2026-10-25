import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { TEAM_SIZE } from '../src/sim/constants.ts';
import { keeperControllable } from '../src/sim/human.ts';
import { createMatch, fingerprint, step, teamInputs } from '../src/sim/match.ts';
import type { HumanInput, MatchState, TeamInputs } from '../src/sim/types.ts';
import { len, sub } from '../src/sim/vec.ts';
import { kickOff } from './helpers.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

function twoHumans(seed = 3, halfSeconds = 30): MatchState {
  return createMatch({ seed, ...teams(7), halfSeconds, humans: [true, true] });
}

function toPlay(s: MatchState, inputs?: TeamInputs): MatchState {
  kickOff(s, inputs);
  return s;
}

/** Scripted pair of inputs for tick t: both sides wander, pass, shoot and switch on different beats. */
function script(t: number): TeamInputs {
  const a: HumanInput = { cursor: { x: 20 + (t % 50) * 0.6, y: 8 + ((t * 7) % 24) } };
  const b: HumanInput = { dir: { x: t % 240 < 120 ? -1 : 1, y: t % 90 < 45 ? 1 : -1 } };
  if (t % 75 === 0) a.pass = true;
  if (t % 210 === 0) a.shoot = 0.8;
  if (t % 64 === 0) b.pass = true;
  if (t % 181 === 0) b.shoot = 0.6;
  if (t % 150 === 0) b.switchPlayer = true;
  if (t % 300 < 80) b.sprint = true;
  return [a, b];
}

describe('two humans in one match', () => {
  test('createMatch: humans and controlled per team, humanTeam still works', () => {
    const both = twoHumans();
    expect(both.humans).toEqual([true, true]);
    expect(both.players[both.controlled[0]].team).toBe(0);
    expect(both.players[both.controlled[1]].team).toBe(1);
    const one = createMatch({ seed: 1, ...teams(7) });
    expect(one.humans).toEqual([true, false]);
    expect(one.controlled[1]).toBe(-1);
    const away = createMatch({ seed: 1, ...teams(7), humanTeam: 1 });
    expect(away.humans).toEqual([false, true]);
    expect(away.controlled[0]).toBe(-1);
    expect(away.players[away.controlled[1]].team).toBe(1);
    const cpu = createMatch({ seed: 1, ...teams(7), humanTeam: -1 });
    expect(cpu.humans).toEqual([false, false]);
    expect(cpu.controlled).toEqual([-1, -1]);
  });

  test('same seed and the same input pairs give the same match', () => {
    const run = () => {
      const s = twoHumans(42, 20);
      for (let t = 1; s.phase !== 'fulltime'; t++) step(s, script(t));
      return `${fingerprint(s)}#${s.rng.s}#${s.stats[0].passes}:${s.stats[1].passes}`;
    };
    const a = run();
    expect(a).toBe(run());
    // And the away human matters: the same match with team 1 left on its own is different.
    const s = twoHumans(42, 20);
    for (let t = 1; s.phase !== 'fulltime'; t++) step(s, [script(t)[0], {}]);
    expect(`${fingerprint(s)}#${s.rng.s}`).not.toBe(a.split('#').slice(0, 2).join('#'));
  });

  test('a single HumanInput is the one-human shorthand (team 0, or the only human team)', () => {
    const inp: HumanInput = { cursor: { x: 1, y: 2 } };
    const s = twoHumans();
    expect(teamInputs(s, inp)).toEqual([inp, {}]);
    expect(teamInputs(s, [{}, inp])).toEqual([{}, inp]);
    const away = createMatch({ seed: 1, ...teams(7), humanTeam: 1 });
    expect(teamInputs(away, inp)).toEqual([{}, inp]);
    // step(s, x) and step(s, [x, {}]) are the same thing for a one-human match.
    const a = createMatch({ seed: 9, ...teams(7), halfSeconds: 10 });
    const b = createMatch({ seed: 9, ...teams(7), halfSeconds: 10 });
    for (let t = 1; t < 1500; t++) {
      step(a, script(t)[0]);
      step(b, [script(t)[0], { cursor: { x: 0, y: 0 }, pass: true }]); // team 1 is CPU: its input is ignored
    }
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  test('each human steers only a player of their own team', () => {
    const s = twoHumans(5, 60);
    for (let t = 1; t < 3000 && s.phase !== 'fulltime'; t++) {
      step(s, script(t));
      expect(s.players[s.controlled[0]].team).toBe(0);
      expect(s.players[s.controlled[1]].team).toBe(1);
      // A keeper only while he has the ball, it is coming to him, or he takes a restart: the human distributes it.
      for (const team of [0, 1] as const) if (s.players[s.controlled[team]].role === 'GK') expect(keeperControllable(s, s.players[s.controlled[team]])).toBe(true);
    }
  });

  test("each team's input moves its own player, and nobody else's", () => {
    const s = toPlay(twoHumans(8, 60));
    const a = s.players[s.controlled[0]];
    const b = s.players[s.controlled[1]];
    for (const p of s.players) if (p !== a && p !== b) p.stun = 1000; // keep control where it is
    s.switchTimer = [1000, 1000]; // and no auto-switch to whoever is now nearer the ball
    // One runs toward each touchline, from wherever the kick-off left them.
    const aTarget = { x: a.pos.x, y: a.pos.y - 14 };
    const bTarget = { x: b.pos.x, y: b.pos.y + 14 };
    const [ay, by] = [a.pos.y, b.pos.y];
    for (let t = 0; t < 60; t++) step(s, [{ cursor: aTarget }, { cursor: bTarget }]);
    expect(s.controlled).toEqual([a.i, b.i]);
    expect(a.pos.y).toBeLessThan(ay - 4);
    expect(b.pos.y).toBeGreaterThan(by + 4);
    // From the same state, changing only one team's input changes only that team's player.
    const run = (inputs: TeamInputs) => {
      const c = structuredClone(s);
      c.switchTimer = [1000, 1000]; // no auto-switch in this short window
      for (let t = 0; t < 15; t++) step(c, inputs);
      return [c.players[a.i].pos, c.players[b.i].pos];
    };
    const up = { cursor: { x: 30, y: 2 } };
    const down = { cursor: { x: 30, y: 66 } };
    const [a1, b1] = run([up, up]);
    const [a2, b2] = run([up, down]);
    const [a3, b3] = run([down, up]);
    expect(a2).toEqual(a1);
    expect(len(sub(b2, b1))).toBeGreaterThan(0.5);
    expect(b3).toEqual(b1);
    expect(len(sub(a3, a1))).toBeGreaterThan(0.5);
  });

  test('switch player only switches the team that asked', () => {
    const s = toPlay(twoHumans(4, 60));
    // Ball loose in the middle, away from everyone's feet.
    s.ball.owner = -1;
    s.ball.receiver = -1;
    s.ball.vel = { x: 0, y: 0 };
    s.ball.pos = { x: 32, y: 20 };
    for (let t = 0; t < 40; t++) step(s, [{}, {}]);
    const before = [...s.controlled];
    step(s, [{}, { switchPlayer: true }]);
    expect(s.controlled[1]).not.toBe(before[1]);
    expect(s.players[s.controlled[1]].team).toBe(1);
    expect(s.controlled[0]).toBe(before[0]);
  });

  test('the CPU still runs every other player on both human teams', () => {
    const s = toPlay(twoHumans(6, 60));
    const start = s.players.map((p) => ({ ...p.pos }));
    for (let t = 0; t < 240; t++) step(s, [{}, {}]);
    const moved = s.players.filter((p) => p.i !== s.controlled[0] && p.i !== s.controlled[1] && len(sub(p.pos, start[p.i])) > 1);
    expect(moved.filter((p) => p.team === 0).length).toBeGreaterThan(2);
    expect(moved.filter((p) => p.team === 1).length).toBeGreaterThan(2);
    expect(s.players.length).toBe(TEAM_SIZE * 2);
  });

  test('kick-off hands control to the team kicking off, per team', () => {
    const s = twoHumans(2, 60);
    expect(s.controlled[0]).toBe(s.ball.owner);
    expect(s.players[s.controlled[1]].team).toBe(1);
  });
});
