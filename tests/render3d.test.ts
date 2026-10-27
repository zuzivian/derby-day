// The 3D renderer's state reading, without a browser: the animation director
// turns sim changes into events, the HUD words come from the sim's events,
// and the HUD clock is matchSeconds.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { createMatch, step } from '../src/sim/match.ts';
import { matchSeconds } from '../src/sim/rules.ts';
import type { MatchState } from '../src/sim/types.ts';
import { matchClock, refereeWord } from '../src/client/hud.ts';
import { AnimDirector, inWall, keeperLook, keeperSet } from '../src/client/r3d/director.ts';
import { PlayerKit, createProceduralPlayer, keeperPair, lookFor, type AnimEvent, type PlayerContext, type SimBody } from '../src/client/r3d/player3d.ts';
import { Vector3 } from '../src/client/r3d/three.ts';

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

  test('a keeper facing a penalty is set on his line; the taker is not', () => {
    const s = cpuMatch(15);
    const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
    const taker = s.players.find((p) => p.team === 1 && p.role === 'FWD')!;
    s.phase = 'restart';
    s.restart = { kind: 'penalty', team: 1, spot: { x: 11, y: 34 }, taker: taker.i, stage: 'ready', ticks: 0, direct: true, reason: 'foul', wait: 0 };
    s.ball.pos = { ...s.restart.spot };
    expect(keeperSet(s, gk)).toBe(1);
    expect(keeperSet(s, taker)).toBe(0);
    s.restart.stage = 'whistle';
    expect(keeperSet(s, gk)).toBe(0);
  });

  test('a keeper in play watches the ball (up the pitch when it is on top of him), not the way he is running', () => {
    const s = cpuMatch(15);
    s.phase = 'play';
    const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
    gk.pos = { x: 2, y: 34 };
    gk.facing = { x: 0, y: 1 }; // the sim turns him to his velocity: shuffling along his line
    s.ball.owner = -1;
    s.ball.pos = { x: 22, y: 34 };
    expect(keeperLook(s, gk)).toEqual({ x: 1, y: 0 });
    s.ball.pos = { x: 2, y: 44 };
    expect(keeperLook(s, gk)).toEqual({ x: 0, y: 1 });
    s.ball.pos = { x: 2.5, y: 34.5 };
    expect(keeperLook(s, gk)).toEqual({ x: 1, y: 0 });
    // Not with the ball in his hands, in a dead ball, or for anyone else.
    s.ball.pos = { x: 22, y: 34 };
    s.ball.owner = gk.i;
    expect(keeperLook(s, gk)).toBeNull();
    s.ball.owner = -1;
    s.phase = 'restart';
    expect(keeperLook(s, gk)).toBeNull();
    s.phase = 'play';
    expect(keeperLook(s, s.players.find((p) => p.team === 0 && p.role === 'DEF')!)).toBeNull();
  });

  test('a keeper dive is drawn sideways to where he watches, carries no travel of its own, and his going down after it is not a knockdown', () => {
    const s = cpuMatch(18);
    s.phase = 'play';
    const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
    gk.pos = { x: 2, y: 34 };
    gk.facing = { x: 0, y: 1 };
    s.ball.owner = -1;
    s.ball.pos = { x: 22, y: 34 };
    const d = new AnimDirector();
    d.update(s, 0);
    // He watches +x, so +y is on his right.
    s.tick++;
    gk.dive = { dir: { x: 0, y: 1 }, speed: 3, ticks: 30, travel: 22, z: 0.5 };
    const dive = d.update(s, 1 / 60).events[gk.i].find((e) => e.kind === 'dive');
    expect(dive).toMatchObject({ kind: 'dive', side: 1, reach: 0 });
    // The sim stuns him for the time he lies there.
    s.tick++;
    gk.dive.ticks = 0;
    gk.stun = 24;
    expect(d.update(s, 2 / 60).events[gk.i].some((e) => e.kind === 'knockdown')).toBe(false);
    // A dive the other way.
    const t = new AnimDirector();
    gk.dive = null;
    gk.stun = 0;
    t.update(s, 0);
    s.tick++;
    gk.dive = { dir: { x: 0, y: -1 }, speed: 3, ticks: 30, travel: 22, z: 0.5 };
    expect(t.update(s, 1 / 60).events[gk.i].find((e) => e.kind === 'dive')).toMatchObject({ side: -1 });
  });

  test('a keeper letting the ball roll out of his hands bowls it, one who kicks it from his hands kicks, an outfielder passes', () => {
    const s = cpuMatch(19);
    s.phase = 'play';
    const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
    const def = s.players.find((p) => p.team === 0 && p.role === 'DEF')!;
    const release = (who: typeof gk, hands: boolean, z: number, vz: number) => {
      const d = new AnimDirector();
      s.ball.owner = who.i;
      s.ball.inHands = hands;
      s.ball.z = 1;
      s.ball.vel = { x: 0, y: 0 };
      d.update(s, 0);
      s.tick++;
      s.ball.owner = -1;
      s.ball.inHands = false;
      s.ball.z = z;
      s.ball.vz = vz;
      s.ball.vel = { x: 12, y: 0 };
      who.kickCd = 18;
      const kick = d.update(s, 1 / 60).events[who.i].find((e) => e.kind === 'kick');
      who.kickCd = 0;
      return kick && kick.kind === 'kick' ? kick.style : null;
    };
    expect(release(gk, true, 0, 0)).toBe('roll');
    expect(release(gk, true, 1.5, 9)).toBe('chip');
    expect(release(gk, false, 0, 0)).toBe('pass');
    expect(release(def, false, 0, 0)).toBe('pass');
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

describe('keeper model poses', () => {
  const ctx = (time: number): PlayerContext => ({ time, dtSim: 1 / 60, lead: 0, keeperSet: 0, throwHold: false, holding: false, hasBall: false, wall: false, reducedMotion: true });

  /** A keeper on the origin facing +x who dives to `side` (1 his right, -1 his left): where his head and hands are after `after` seconds. */
  function dived(side: 1 | -1, after: number) {
    const kit = new PlayerKit();
    const [k] = keeperPair('#cc2222', '#2222cc');
    const m = createProceduralPlayer(kit, lookFor('gk', k, null, true, () => 0.5));
    const body: SimBody = { pos: { x: 60, y: 34 }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 } };
    // The sim's dive carries him along it (here it has ended): the model adds no travel of its own.
    const dive: AnimEvent = { kind: 'dive', t0: 0, side, height: 0.3, reach: 0 };
    let time = 0;
    m.update(1 / 60, body, [dive], ctx(time));
    while (time < after) {
      time += 1 / 60;
      m.update(1 / 60, body, [], ctx(time));
    }
    const head = m.headTop(new Vector3());
    const hands = m.handsWorld(new Vector3());
    const root = m.object.position;
    m.dispose();
    kit.dispose();
    // Sim y is scene z, and facing +x puts his right on +y.
    return { across: (head.z - root.z) * side, headY: head.y, handsAcross: (hands.z - root.z) * side, root };
  }

  test('a diving keeper lies out along the dive on the grass, centred on where the sim has him, the right way round', () => {
    for (const side of [1, -1] as const) {
      const d = dived(side, 0.7);
      // Stretched out to his side of the dive, low, not sunk into the pitch nor stood up.
      expect(d.headY).toBeGreaterThan(0.1);
      expect(d.headY).toBeLessThan(0.8);
      expect(d.across).toBeGreaterThan(0.3);
      expect(d.across).toBeLessThan(1.6);
      expect(d.handsAcross).toBeGreaterThan(d.across * 0.8);
    }
  });

  test('and he is on his feet again by the end of it', () => {
    const d = dived(1, 1.4);
    expect(d.headY).toBeGreaterThan(1.5);
    expect(Math.abs(d.across)).toBeLessThan(0.5);
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
    // The search plays as many short matches as it takes, which moves with any change to the sim.
  }, 30_000);

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
