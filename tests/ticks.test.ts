import { describe, expect, test } from 'bun:test';
import { DT } from '../src/sim/constants.ts';
import { tickDue } from '../src/client/ticks.ts';

/**
 * The live match loop at a given refresh rate, with clicks at seeded random times: how long from a
 * click to the tick that takes it (the frame that runs it draws it). `rule` decides when to tick.
 */
function run(hz: number, rule: (acc: number, ran: number, waiting: boolean) => boolean, secs = 120) {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const frame = 1 / hz;
  let t = 0;
  let acc = 0;
  let ticks = 0;
  let maxAhead = 0;
  let nextClick = rnd() * 0.5;
  let waitingSince: number | null = null;
  const delays: number[] = [];
  while (t < secs) {
    t += frame * (0.97 + 0.06 * rnd()); // a little frame-time jitter
    if (waitingSince === null && t >= nextClick) waitingSince = nextClick; // the click landed before this frame
    acc += frame;
    let ran = 0;
    while (ran < 12 && rule(acc, ran, waitingSince !== null)) {
      if (waitingSince !== null) {
        delays.push((t - waitingSince) * 1000);
        waitingSince = null;
        nextClick = t + 0.2 + rnd() * 0.6;
      }
      acc -= DT;
      ran++;
      ticks++;
    }
    maxAhead = Math.max(maxAhead, ticks - t / DT);
  }
  const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
  const sorted = [...delays].sort((a, b) => a - b);
  return { avg, p95: sorted[Math.floor(sorted.length * 0.95)], ticks, expected: secs / DT, maxAhead };
}

const before = (acc: number) => acc >= DT;

describe('live match ticks', () => {
  for (const hz of [60, 120, 144, 30]) {
    test(`${hz} Hz: a click is taken by the next frame, never a tick later; the sim keeps real time`, () => {
      const old = run(hz, before);
      const now = run(hz, tickDue);
      console.log(`${hz} Hz: click to its tick avg ${old.avg.toFixed(1)} → ${now.avg.toFixed(1)} ms, p95 ${old.p95.toFixed(1)} → ${now.p95.toFixed(1)} ms`);
      // Never later than before, and at most one frame (plus jitter) after the click.
      expect(now.avg).toBeLessThanOrEqual(old.avg + 0.01);
      expect(now.p95).toBeLessThanOrEqual((1000 / hz) * 1.04);
      // Real time: the same number of ticks over two minutes, and never more than one tick ahead of the wall clock.
      expect(Math.abs(now.ticks - now.expected)).toBeLessThanOrEqual(2);
      expect(now.maxAhead).toBeLessThanOrEqual(1.05);
    });
  }
});
