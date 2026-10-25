// Free kicks on screen: the mouse bends a set-piece shot (a drag across its line while the button is
// held), the aim shows the strike's real flight, the HUD names the kind of free kick and the referee
// keeps his arm up for an indirect one, and the coach says how to get it over the wall.

import { describe, expect, test } from 'bun:test';
import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { CoachTracker } from '../src/client/coach.ts';
import { freeKickKind } from '../src/client/hud.ts';
import { CURL_DRAG_M, curlFrom, setPieceSpot, InputController } from '../src/client/input.ts';
import { PITCH_H } from '../src/sim/constants.ts';
import { oppGoal } from '../src/sim/field.ts';
import { strikePath } from '../src/sim/kicks.ts';
import { createMatch, freeKickPlan, step } from '../src/sim/match.ts';
import { awardRestart, indirectPending } from '../src/sim/rules.ts';
import type { MatchState } from '../src/sim/types.ts';
import { kickOff } from './helpers.ts';

const MID = PITCH_H / 2;

(globalThis as Record<string, unknown>).window ??= new EventTarget();

function pointerEvent(type: string, x: number, y: number, button = 0): Event {
  const e = new Event(type);
  for (const [k, v] of Object.entries({ clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, button })) Object.defineProperty(e, k, { value: v });
  return e;
}

function match(): MatchState {
  const [a, b] = generateLadder(7, 2);
  const s = createMatch({ seed: 4, home: cpuTeam(a, ladderSquad(a)), away: cpuTeam(b, ladderSquad(b)), halfSeconds: 900, humanTeam: 0 });
  kickOff(s);
  return s;
}

/** A free kick to the human side 23 m out, at the first tick he can take it. */
function freeKickReady(direct = true): MatchState {
  const s = match();
  awardRestart(s, 'freekick', 0, { x: oppGoal(s, 0).x - 23, y: MID + 2 }, 'foul', direct);
  for (let n = 0; n < 900 && s.restart && s.restart.stage !== 'ready'; n++) step(s, { cursor: { ...s.players[s.controlled[0]].pos } });
  return s;
}

describe('curl from a drag', () => {
  test('across the line of the shot, either way; a wobble is no curl; full bend at CURL_DRAG_M', () => {
    const ball = { x: 80, y: 34 };
    const at = { x: 105, y: 34 }; // straight down +x: the kicker's left is +y
    expect(curlFrom(ball, at, { x: 105, y: 34.2 })).toBe(0);
    expect(curlFrom(ball, at, { x: 105, y: 36 })).toBeGreaterThan(0);
    expect(curlFrom(ball, at, { x: 105, y: 32 })).toBeLessThan(0);
    expect(curlFrom(ball, at, { x: 105, y: 34 + CURL_DRAG_M })).toBeCloseTo(1, 5);
    expect(curlFrom(ball, at, { x: 105, y: 34 - 10 })).toBe(-1);
    // Along the line (further or shorter) is no bend.
    expect(curlFrom(ball, at, { x: 99, y: 34 })).toBe(0);
  });

  test('over a free kick the shot goes where right went down, curled by the drag; in open play it goes where it came up', () => {
    const run = (s: MatchState) => {
      const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }) }) as unknown as HTMLCanvasElement;
      // Screen pixels are world decimetres.
      const input = new InputController(canvas, { toWorld: (x, y) => ({ x: x / 10, y: y / 10 }) }, () => s.ball.owner === s.controlled[0], () => {});
      input.setPiece = () => setPieceSpot(s, 0);
      canvas.dispatchEvent(pointerEvent('pointermove', 1040, 360));
      canvas.dispatchEvent(pointerEvent('pointerdown', 1040, 360, 2));
      canvas.dispatchEvent(pointerEvent('pointermove', 1040, 390)); // 3 m toward +y, while held
      (globalThis as unknown as EventTarget & { window: EventTarget }).window.dispatchEvent(pointerEvent('pointerup', 1040, 390, 2));
      const taken = input.take();
      input.dispose();
      return taken;
    };
    const s = freeKickReady();
    expect(setPieceSpot(s, 0)).toEqual(s.restart!.spot);
    const fk = run(s);
    expect(fk.shoot).toBeGreaterThan(0);
    expect(fk.aim).toEqual({ x: 104, y: 36 });
    expect(fk.curl!).toBeGreaterThan(0.5);
    const open = match();
    open.ball.owner = open.controlled[0];
    const shot = run(open);
    expect(shot.aim).toEqual({ x: 104, y: 39 });
    expect(shot.curl).toBeUndefined();
  });
});

describe('the aim shows the strike', () => {
  test("the drawn flight is the sim's: it ends where the error-free strike crosses the line, over the wall", () => {
    const s = freeKickReady();
    const taker = s.players[s.restart!.taker];
    const target = { x: oppGoal(s, 0).x, y: MID - 3 };
    for (const curl of [0, 0.8, -0.8]) {
      const plan = freeKickPlan(s, taker, target, 0.6, curl);
      const pts = strikePath(plan.from, plan, 40);
      const end = pts[pts.length - 1];
      expect(Math.abs(end.x - target.x)).toBeLessThan(0.6);
      expect(Math.abs(end.y - target.y)).toBeLessThan(0.6);
      expect(plan.over).toBe(true);
      // Above the wall's heads where it passes the wall (9.3 m out).
      const atWall = pts.find((p) => Math.hypot(p.x - plan.from.x, p.y - plan.from.y) >= 9.3)!;
      expect(atWall.z).toBeGreaterThan(2.9);
      // The same strike in the sim, error aside, follows that path: step it and compare at the wall.
      const t = structuredClone(s);
      t.rng = { ...t.rng }; // its own copy
      step(t, { cursor: target, aim: target, shoot: 0.6, ...(curl ? { curl } : {}) });
      let sim = { ...t.ball.pos, z: t.ball.z };
      for (let k = 0; k < 120 && Math.hypot(t.ball.pos.x - plan.from.x, t.ball.pos.y - plan.from.y) < 9.3; k++) {
        step(t, { cursor: { ...t.players[t.controlled[0]].pos } });
        sim = { ...t.ball.pos, z: t.ball.z };
      }
      expect(Math.abs(sim.z - atWall.z)).toBeLessThan(0.9);
    }
  });
});

describe('the kind of free kick, on screen', () => {
  test('direct, or indirect until a second touch; the referee keeps his arm up for it', () => {
    const d = freeKickReady(true);
    expect(freeKickKind(d)).toBe('direct');
    expect(indirectPending(d)).toBe(false);
    const s = freeKickReady(false);
    expect(freeKickKind(s)).toBe('indirect');
    expect(indirectPending(s)).toBe(true);
    // Played short to a team-mate: still indirect while the ball travels to him, over once he has it.
    const taker = s.players[s.restart!.taker];
    const mate = s.players.filter((p) => p.team === 0 && p.i !== taker.i && p.role !== 'GK').sort((a, b) => Math.hypot(a.pos.x - taker.pos.x, a.pos.y - taker.pos.y) - Math.hypot(b.pos.x - taker.pos.x, b.pos.y - taker.pos.y))[0];
    step(s, { cursor: { ...mate.pos }, aim: { ...mate.pos }, pass: true, moved: true });
    expect(s.phase).toBe('play');
    expect(indirectPending(s)).toBe(true);
    for (let k = 0; k < 240 && s.ball.lastTouch === taker.i; k++) step(s, { cursor: { ...s.players[s.controlled[0]].pos } });
    expect(indirectPending(s)).toBe(false);
    expect(freeKickKind(s)).toBe('');
  });
});

describe('the coach', () => {
  test('the first direct free kick with a wall to beat says how to get it over, before the general restart tip', () => {
    const s = freeKickReady();
    const c = new CoachTracker(['run']);
    const got = c.observe(s, 0);
    expect(got[0]).toBe('freekick');
    expect(got).toContain('restart');
    expect(c.relevant('freekick', s, 0)).toBe(true);
  });
});
