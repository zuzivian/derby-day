// Keeper save rates by quality and distance (owner asks 5 and the review of #8). The shot scene
// and its helpers are copied from tests/physics.test.ts so this file stands alone.

import { expect, test } from 'bun:test';
import { CLICK_MS, leftRelease, loftPower, OneEuro, TOUCH_CLICK_MS } from '../src/client/input.ts';
import { kickGauge, PASS_FULL } from '../src/client/power.ts';
import { longView } from '../src/client/r3d/renderer3d.ts';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { decodeReplay, encodeReplay, finalHash, quantiseInput, replayTo, ReplayRecorder } from '../src/meta/replay.ts';
import { GOAL_BOTTOM, GOAL_TOP, PITCH_H, PITCH_W, RESTART_HUMAN_WAIT } from '../src/sim/constants.ts';
import { goalkeeper } from '../src/sim/field.ts';
import { keeperControllable } from '../src/sim/human.ts';
import { assistRadius, groundPassPlan, pointerPass, PUNT_MIN_RANGE, receiverArrival, rollDistance } from '../src/sim/kicks.ts';
import { createMatch, fingerprint, KEEPER_HOLD_TICKS, possessionShare, step } from '../src/sim/match.ts';
import { awardRestart } from '../src/sim/rules.ts';
import type { HumanInput, MatchPlayer, MatchState } from '../src/sim/types.ts';
import { dist, len, type Vec } from '../src/sim/vec.ts';
import { openPlay } from './helpers.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

function livePlay(seed = 5, humanTeam: 0 | 1 | -1 = 0): MatchState {
  const s = createMatch({ seed, ...teams(7), halfSeconds: 60, humanTeam });
  openPlay(s);
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

const mid = (s: MatchState, team: 0 | 1, k = 0) => s.players.filter((p) => p.team === team && p.role === 'MID')[k];

/** The human has the ball at `at`, one teammate `mate` is free at `mateAt`, nobody else around. */
function passScene(at: Vec, mateAt: Vec) {
  const s = livePlay();
  const me = s.players[s.controlled[0]];
  const mate = s.players.find((p) => p.team === 0 && p.role === 'MID' && p.i !== me.i)!;
  isolate(s, me, mate);
  s.switchTimer[0] = 1e9;
  me.pos = { ...at };
  me.vel = { x: 0, y: 0 };
  me.facing = { x: 1, y: 0 };
  mate.pos = { ...mateAt };
  mate.vel = { x: 0, y: 0 };
  s.ball.owner = me.i;
  s.ball.pos = { x: at.x + 0.99, y: at.y };
  s.ball.vel = { x: 0, y: 0 };
  return { s, me, mate };
}


function fire(s: MatchState, from: Vec, vel: Vec, z = 0, vz = 0) {
  const b = s.ball;
  b.owner = -1;
  b.receiver = -1;
  b.passFrom = -1;
  b.inHands = false;
  b.pos = { ...from };
  b.vel = { ...vel };
  b.z = z;
  b.vz = vz;
  b.kickedBy = -1;
  b.lastTouch = -1;
  b.touch = 0;
  b.noPickup.fill(0);
}

function shot(yAim: number, speed: number, z = 0, vz = 0, gkSkill = 0.75, dist = 20, fromY = PITCH_H / 2) {
    const s = livePlay(4, -1);
    const gk = goalkeeper(s, 1);
    const shooter = s.players.find((p) => p.team === 0 && p.role === 'FWD')!;
    isolate(s, gk, shooter);
    gk.stun = 0;
    gk.pos = { x: PITCH_W - 1, y: PITCH_H / 2 };
    gk.vel = { x: 0, y: 0 };
    gk.attrs.goalkeeping = gkSkill;
    shooter.pos = { x: PITCH_W - dist - 1, y: fromY };
    shooter.stun = 0;
    const from = { x: PITCH_W - dist, y: fromY };
    const d = Math.hypot(dist, yAim - fromY);
    fire(s, from, { x: (speed * dist) / d, y: (speed * (yAim - fromY)) / d }, z, vz);
    s.ball.kickedBy = shooter.i;
    s.ball.lastTouch = shooter.i;
    s.ball.noPickup[shooter.i] = 30;
    shooter.kickCd = 18;
    shooter.stun = 100000; // he has struck it; he takes no further part
    const goals = s.score[0];
    let dived = false;
    let touched = false;
    // Until the keeper has touched it (or it is dead): a rebound is another story.
    let diveEndedEarly = false;
    for (let t = 0; t < 150 && s.phase === 'play' && !touched; t++) {
      const wasDiving = !!gk.dive && gk.dive.ticks > 0;
      step(s);
      if (gk.dive && gk.dive.ticks > 0) dived = true;
      if (s.ball.lastTouch === gk.i) touched = true;
      // The dive is over and he is back on his feet with the ball still on its way to him.
      if (wasDiving && !gk.dive && s.ball.pos.x < gk.pos.x - 0.5) diveEndedEarly = true;
    }
    // A parry: follow it a second longer, nobody else involved, to see it does not go in.
    for (let t = 0; t < 60 && s.phase === 'play' && touched && s.ball.owner < 0; t++) step(s);
    return { s, gk, goal: s.score[0] > goals, dived, touched, caught: s.ball.owner === gk.i, scorer: s.goals[s.goals.length - 1], diveEndedEarly };
  }


// Save rates by keeper quality and distance, on evenly placed ground shots on target at
// 20-30 m/s (the scene is tests/physics.test.ts's). What they should look like: a top keeper
// beaten now and then by a well-placed shot, a weak one not a sieve from distance, and every
// keeper better the more time the shot gives him.
test('keeper save rates: by quality and distance', () => {
  const rate = (g: number, d: number) => {
    let saves = 0;
    const n = 40;
    for (let k = 0; k < n; k++) {
      const y = PITCH_H / 2 + (((k * 37) % 40) / 40 - 0.5) * 6.6;
      if (!shot(y, 20 + ((k * 13) % 11), 0, 0, g, d).goal) saves++;
    }
    return saves / n;
  };
  const table = [12, 18, 24].map((d) => [0.3, 0.6, 0.9].map((g) => rate(g, d)));
  console.log(`saves by keeper 0.3 / 0.6 / 0.9:\n${table.map((r, i) => `  ${[12, 18, 24][i]} m: ${r.map((v) => `${Math.round(v * 100)}%`).join(' / ')}`).join('\n')}`);
  const top = (table[0][2] + table[1][2] + table[2][2]) / 3;
  expect(top).toBeGreaterThan(0.8);
  expect(top).toBeLessThan(0.96);
  // Weak keepers: beaten often up close, not a sieve from distance.
  expect(table[0][0]).toBeLessThan(0.6);
  expect(table[2][0]).toBeGreaterThan(0.45);
  // Quality matters at every distance.
  for (const r of table) expect(r[2]).toBeGreaterThan(r[0] + 0.2);
}, 30_000);
