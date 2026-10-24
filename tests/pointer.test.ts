// The mouse and the moving 3D camera together (red-team round 1, the still-pointer finding): with
// the mouse held still, the player runs to the grass that was under it and stops there, while the
// broadcast camera follows him. Uses the real InputController (with a stand-in DOM), the real
// MatchCamera and the real sim, all stepped at 60 Hz.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { InputController } from '../src/client/input.ts';
import { MatchCamera } from '../src/client/r3d/camera3d.ts';
import { sx, sz, wx, wy } from '../src/client/r3d/space.ts';
import { Plane, Raycaster, Vector2, Vector3 } from '../src/client/r3d/three.ts';
import { attackDir } from '../src/sim/field.ts';
import { createMatch, step } from '../src/sim/match.ts';
import type { MatchState } from '../src/sim/types.ts';

const W = 1040;
const H = 697;

// The browser bits InputController touches: window listeners and the canvas's rect.
(globalThis as Record<string, unknown>).window ??= new EventTarget();

function pointerEvent(type: string, x: number, y: number, extra: Record<string, unknown> = {}): Event {
  const e = new Event(type);
  for (const [k, v] of Object.entries({ clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, button: 0, ...extra })) Object.defineProperty(e, k, { value: v });
  return e;
}

function rig(s: MatchState) {
  const cam = new MatchCamera();
  const rc = new Raycaster();
  const ground = new Plane(new Vector3(0, 1, 0), 0);
  const hit = new Vector3();
  const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) }) as unknown as HTMLCanvasElement;
  const cut = { n: 0 };
  const picker = {
    cuts: () => cut.n,
    toWorld(cx: number, cy: number) {
      rc.setFromCamera(new Vector2((cx / W) * 2 - 1, -(cy / H) * 2 + 1), cam.camera);
      rc.ray.intersectPlane(ground, hit);
      return { x: wx(hit.x), y: wy(hit.z) };
    },
  };
  const input = new InputController(canvas, picker, () => s.ball.owner === s.controlled[0], () => {});
  // The renderer's open-play focus: the carrier blended with the ball, with the attack lead.
  const frame = () => {
    const b = s.ball;
    const holder = b.owner >= 0 ? s.players[b.owner] : null;
    const fx = holder ? holder.pos.x * 0.6 + b.pos.x * 0.4 : b.pos.x;
    const fy = holder ? holder.pos.y * 0.6 + b.pos.y * 0.4 : b.pos.y;
    cam.update(1 / 60, { x: sx(fx), z: sz(fy), vx: b.vel.x, vz: b.vel.y, air: b.z, attack: holder ? attackDir(holder.team) : 0, phase: s.phase, close: null, humanDir: 1 }, W / H, W, false);
  };
  // Where on screen a world point is, for placing the mouse.
  const screenOf = (x: number, y: number) => {
    const v = new Vector3(sx(x), 0, sz(y)).project(cam.camera);
    return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
  };
  return { cam, canvas, input, frame, screenOf, cut };
}

function setup(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  const s = createMatch({ seed, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds: 600, humans: [true, false] });
  for (let t = 0; t < 400 || (s.phase !== 'play' && t < 4000); t++) step(s, {});
  // Our man on the ball in midfield; everyone else frozen out of the way.
  const me = s.players[s.controlled[0]];
  for (const p of s.players) if (p !== me) p.stun = 1e7;
  me.pos = { x: 40, y: 34 };
  me.vel = { x: 0, y: 0 };
  s.ball.pos = { x: 40.4, y: 34 };
  s.ball.vel = { x: 0, y: 0 };
  s.ball.z = 0;
  s.ball.owner = me.i;
  return { s, me };
}

describe('a still mouse and the moving camera', () => {
  for (const [ax, ay] of [
    [10, 0],
    [14, 0],
    [0, 9],
    [-8, -6],
  ]) {
    test(`aim ${ax}, ${ay} m away: he arrives at that grass and stops there`, () => {
      const { s, me } = setup(21);
      const r = rig(s);
      for (let i = 0; i < 120; i++) r.frame(); // camera settled on him
      const goal = { x: me.pos.x + ax, y: me.pos.y + ay };
      const at = r.screenOf(goal.x, goal.y);
      r.canvas.dispatchEvent(pointerEvent('pointermove', at.x, at.y));
      let maxFrom = 0;
      for (let t = 0; t < 6 * 60; t++) {
        step(s, r.input.take());
        r.frame();
        maxFrom = Math.max(maxFrom, Math.hypot(me.pos.x - 40, me.pos.y - 34));
      }
      const d = Math.hypot(me.pos.x - goal.x, me.pos.y - goal.y);
      expect(d).toBeLessThan(1.5);
      expect(Math.hypot(me.vel.x, me.vel.y)).toBeLessThan(0.6);
      // No overshoot run past the target (it used to carry on 15 to 50 m).
      expect(maxFrom).toBeLessThan(Math.hypot(ax, ay) + 2);
      expect(s.phase).toBe('play');
    });
  }

  test('moving the mouse again takes the new point under it', () => {
    const { s, me } = setup(22);
    const r = rig(s);
    for (let i = 0; i < 120; i++) r.frame();
    const a = r.screenOf(me.pos.x + 10, me.pos.y);
    r.canvas.dispatchEvent(pointerEvent('pointermove', a.x, a.y));
    for (let t = 0; t < 120; t++) {
      step(s, r.input.take());
      r.frame();
    }
    const b = r.screenOf(me.pos.x, me.pos.y + 6);
    r.canvas.dispatchEvent(pointerEvent('pointermove', b.x, b.y));
    const want = { x: me.pos.x, y: me.pos.y + 6 };
    expect(Math.hypot(r.input.cursor!.x - want.x, r.input.cursor!.y - want.y)).toBeLessThan(0.2);
  });
});

describe('a click with a still mouse goes where the ring and wedge show', () => {
  // Review of #15: pointerdown re-projected through the panned camera, so the click target was 3 to 12 m
  // away from the latched point the ring and wedge showed.
  for (const [ax, ay] of [
    [10, 0],
    [14, 0],
    [0, 9],
    [-8, -6],
  ]) {
    test(`aim ${ax}, ${ay}: after the camera pans, a click keeps the latched point`, () => {
      const { s, me } = setup(31);
      const r = rig(s);
      for (let i = 0; i < 120; i++) r.frame();
      const at = r.screenOf(me.pos.x + ax, me.pos.y + ay);
      r.canvas.dispatchEvent(pointerEvent('pointermove', at.x, at.y));
      const latched = { ...r.input.cursor! };
      // He runs at it and the camera follows; the mouse doesn't move.
      for (let t = 0; t < 90; t++) {
        step(s, r.input.take());
        r.frame();
      }
      expect(r.input.cursor).toEqual(latched);
      r.canvas.dispatchEvent(pointerEvent('pointerdown', at.x, at.y, { button: 0 }));
      expect(r.input.cursor).toEqual(latched);
      (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(pointerEvent('pointerup', at.x, at.y, { button: 0 }));
      const sent = r.input.take();
      if (sent.aim) expect(Math.hypot(sent.aim.x - latched.x, sent.aim.y - latched.y)).toBeLessThan(0.01);
      expect(Math.hypot(sent.cursor!.x - latched.x, sent.cursor!.y - latched.y)).toBeLessThan(0.3);
    });
  }

  test('a press after the pointer moved takes the new point', () => {
    const { s, me } = setup(32);
    const r = rig(s);
    for (let i = 0; i < 120; i++) r.frame();
    const a = r.screenOf(me.pos.x + 10, me.pos.y);
    r.canvas.dispatchEvent(pointerEvent('pointermove', a.x, a.y));
    const b = r.screenOf(me.pos.x + 4, me.pos.y + 5);
    r.canvas.dispatchEvent(pointerEvent('pointerdown', b.x, b.y, { button: 0 }));
    expect(Math.hypot(r.input.cursor!.x - (me.pos.x + 4), r.input.cursor!.y - (me.pos.y + 5))).toBeLessThan(0.2);
  });

  test('after a camera cut, the still pointer takes the grass now under it', () => {
    const { s, me } = setup(33);
    const r = rig(s);
    for (let i = 0; i < 120; i++) r.frame();
    const a = r.screenOf(me.pos.x + 10, me.pos.y);
    r.canvas.dispatchEvent(pointerEvent('pointermove', a.x, a.y));
    r.input.take();
    const before = { ...r.input.cursor! };
    // The camera jumps (a cut), and the renderer reports it.
    r.cam.zoom = 1.4;
    r.cam.snap();
    r.frame();
    r.cut.n++;
    r.input.take();
    expect(Math.hypot(r.input.cursor!.x - before.x, r.input.cursor!.y - before.y)).toBeGreaterThan(1);
  });
});

describe('touch: a lost pointerup does not kill steering', () => {
  test('a fresh primary touch steers even if an old id was never released', () => {
    const { s } = setup(34);
    const r = rig(s);
    for (let i = 0; i < 60; i++) r.frame();
    r.canvas.dispatchEvent(pointerEvent('pointerdown', 500, 400, { pointerType: 'touch', pointerId: 3, isPrimary: true }));
    // Its pointerup is lost. Next gesture:
    r.canvas.dispatchEvent(pointerEvent('pointerdown', 300, 300, { pointerType: 'touch', pointerId: 4, isPrimary: true }));
    const at = { ...r.input.cursor! };
    r.canvas.dispatchEvent(pointerEvent('pointermove', 200, 250, { pointerType: 'touch', pointerId: 4, isPrimary: true }));
    expect(r.input.cursor).not.toEqual(at);
  });
});

describe('touch: a pinch does not steer', () => {
  test('a second finger, and both fingers moving, leave the cursor where the first finger put it', () => {
    const { s } = setup(23);
    const r = rig(s);
    for (let i = 0; i < 60; i++) r.frame();
    const t1 = { pointerType: 'touch', pointerId: 7, isPrimary: true };
    const t2 = { pointerType: 'touch', pointerId: 8 };
    r.canvas.dispatchEvent(pointerEvent('pointerdown', 500, 400, t1));
    const before = { ...r.input.cursor! };
    r.canvas.dispatchEvent(pointerEvent('pointerdown', 560, 400, t2));
    r.canvas.dispatchEvent(pointerEvent('pointermove', 440, 380, t1));
    r.canvas.dispatchEvent(pointerEvent('pointermove', 660, 420, t2));
    expect(r.input.cursor).toEqual(before);
    // One finger again after the pinch: the remaining (second) finger doesn't take over steering mid-gesture.
    (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(pointerEvent('pointerup', 440, 380, t1));
    r.canvas.dispatchEvent(pointerEvent('pointermove', 700, 300, t2));
    expect(r.input.cursor).toEqual(before);
    // A fresh touch steers.
    (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(pointerEvent('pointerup', 700, 300, t2));
    r.canvas.dispatchEvent(pointerEvent('pointerdown', 300, 300, { pointerType: 'touch', pointerId: 9 }));
    expect(r.input.cursor).not.toEqual(before);
  });
});
