// Touch feel: a new finger steers from where it lands (no glide from the last touch), a cancelled pad press
// never kicks, and a slow second-finger or finger tap still counts as a tap. Real InputController, stand-in DOM.

import { describe, expect, test } from 'bun:test';
import { InputController, TOUCH_CLICK_MS } from '../src/client/input.ts';

(globalThis as Record<string, unknown>).window ??= new EventTarget();

function ev(type: string, x: number, y: number, extra: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries({ clientX: x, clientY: y, pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, ...extra })) Object.defineProperty(e, k, { value: v });
  return e;
}

function rig(hasBall = true) {
  const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 600 }) }) as unknown as HTMLCanvasElement;
  const picker = { toWorld: (x: number, y: number) => ({ x: x / 4, y: y / 6 }) };
  const state = { ball: hasBall };
  const input = new InputController(canvas, picker, () => state.ball, () => {});
  const pad = () => Object.assign(new EventTarget(), { classList: { add() {}, remove() {} }, style: { removeProperty() {}, setProperty() {} } }) as unknown as HTMLElement;
  const passBtn = pad();
  const shootBtn = pad();
  input.bindTouchButtons(passBtn, shootBtn);
  return { canvas, input, passBtn, shootBtn, state };
}

describe('touch feel', () => {
  test('a fresh finger far from the last one: the very first tick already aims at it', () => {
    const { canvas, input } = rig();
    canvas.dispatchEvent(ev('pointerdown', 40, 60));
    for (let i = 0; i < 20; i++) input.take();
    window.dispatchEvent(ev('pointerup', 40, 60));
    for (let i = 0; i < 20; i++) input.take();
    canvas.dispatchEvent(ev('pointerdown', 360, 540));
    const c = input.take().cursor!;
    expect(c.x).toBeCloseTo(90, 5);
    expect(c.y).toBeCloseTo(90, 5);
  });

  test('a still finger keeps the filter (calm), and a drag is still smoothed', () => {
    const { canvas, input } = rig();
    canvas.dispatchEvent(ev('pointerdown', 200, 300));
    input.take();
    canvas.dispatchEvent(ev('pointermove', 240, 300));
    const c = input.take().cursor!;
    expect(c.x).toBeGreaterThan(50);
    expect(c.x).toBeLessThan(60); // raw 60: the filter has not caught up in one tick
  });

  test('a cancelled Shoot or Pass press does not kick; a released one does', () => {
    for (const which of ['shootBtn', 'passBtn'] as const) {
      const r = rig();
      r.canvas.dispatchEvent(ev('pointerdown', 100, 100));
      r.input.take();
      r[which].dispatchEvent(ev('pointerdown', 0, 0, { pointerId: 2, isPrimary: false }));
      r[which].dispatchEvent(ev('pointercancel', 0, 0, { pointerId: 2, isPrimary: false }));
      const t = r.input.take();
      expect(t.pass || t.shoot !== undefined || t.loft !== undefined).toBeFalsy();
      r[which].dispatchEvent(ev('pointerdown', 0, 0, { pointerId: 3, isPrimary: false }));
      r[which].dispatchEvent(ev('pointerup', 0, 0, { pointerId: 3, isPrimary: false }));
      const k = r.input.take();
      expect(!!k.pass || k.shoot !== undefined).toBe(true);
    }
  });

  test('pad press while another finger steers: the kick goes, steering carries on', () => {
    const r = rig();
    r.canvas.dispatchEvent(ev('pointerdown', 100, 100, { pointerId: 1 }));
    r.input.take();
    r.shootBtn.dispatchEvent(ev('pointerdown', 0, 0, { pointerId: 2, isPrimary: false }));
    r.shootBtn.dispatchEvent(ev('pointerup', 0, 0, { pointerId: 2, isPrimary: false }));
    window.dispatchEvent(ev('pointerup', 0, 0, { pointerId: 2, isPrimary: false }));
    r.canvas.dispatchEvent(ev('pointermove', 300, 300, { pointerId: 1 }));
    const t = r.input.take();
    expect(t.shoot).toBeDefined();
    expect(t.cursor!.x).toBeGreaterThan(25); // still following finger 1 (100/4 = 25 -> 75)
  });

  test('a slow tap (up to the touch click time) with no ball still picks a player', () => {
    const r = rig(false);
    const now = performance.now;
    let t = 1000;
    performance.now = () => t;
    try {
      r.canvas.dispatchEvent(ev('pointerdown', 200, 300));
      t += TOUCH_CLICK_MS - 20;
      window.dispatchEvent(ev('pointerup', 202, 301));
      expect(r.input.take().select).toBe(true);
    } finally {
      performance.now = now;
    }
  });
});
