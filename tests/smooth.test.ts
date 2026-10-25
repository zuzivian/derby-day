import { describe, expect, test } from 'bun:test';
import { drawnAt } from '../src/client/render.ts';
import { DT } from '../src/sim/constants.ts';

/**
 * A ball rolling at a steady 12 m/s, ticked at 60 Hz by the match loop's accumulator, drawn on a
 * screen at `hz` with a little frame-time jitter. Compares where it is drawn with where it really is
 * at that moment (its position at the frame's wall time, one tick behind as the loop runs): drawn at
 * the tick position (before) or moved on by velocity × time since the tick (RenderExtras.since).
 */
function run(hz: number, since: boolean) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const v = 12;
  let t = 0;
  let acc = 0;
  let tick = 0;
  let prev: number | null = null;
  const err: number[] = [];
  const steps: number[] = [];
  const out = { x: 0, y: 0 };
  while (t < 30) {
    const dt = (1 / hz) * (0.97 + 0.06 * rnd());
    t += dt;
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      tick++;
    }
    const pos = { x: v * tick * DT, y: 0 };
    const x = since ? drawnAt(out, pos, { x: v, y: 0 }, acc).x : pos.x;
    // Where it truly is now, on the same one-tick-late timeline the loop runs on.
    err.push(Math.abs(x - v * (tick * DT + acc)));
    if (prev !== null) steps.push((x - prev) / dt / v); // 1 = moved exactly as fast as it really is
    prev = x;
  }
  const max = Math.max(...err);
  const jitter = Math.sqrt(steps.reduce((a, s) => a + (s - 1) ** 2, 0) / steps.length);
  return { max, jitter };
}

describe('smooth motion between ticks', () => {
  for (const hz of [60, 120, 144, 90]) {
    test(`${hz} Hz: a moving ball is drawn where it is, at an even pace, not in tick-sized steps`, () => {
      const old = run(hz, false);
      const now = run(hz, true);
      console.log(`${hz} Hz: max error ${(old.max * 100).toFixed(1)} → ${(now.max * 100).toFixed(1)} cm, speed jitter ${(old.jitter * 100).toFixed(0)}% → ${(now.jitter * 100).toFixed(1)}%`);
      expect(now.max).toBeLessThan(0.001);
      expect(now.jitter).toBeLessThan(0.01);
    });
  }
  test('drawnAt moves a point on by its velocity for the given time', () => {
    expect(drawnAt({ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 10, y: -5 }, 0.01)).toEqual({ x: 1.1, y: 1.95 });
  });
});
