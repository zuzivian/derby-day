import { describe, expect, test } from 'bun:test';
import { GOV_SETTLE_MS, QualityGovernor } from '../src/client/r3d/governor.ts';

/** Run `secs` seconds of frames at a steady draw time and frame interval; returns the steps taken. */
function run(g: QualityGovernor, drawMs: number, frameMs: number, secs: number, t0 = 0) {
  const steps: string[] = [];
  for (let t = t0; t < t0 + secs * 1000; t += frameMs) {
    const st = g.sample(drawMs, frameMs, t);
    if (st) steps.push(st.kind === 'shadows' ? `shadows/${st.every}` : `pixels ${st.ratio}`);
  }
  return steps;
}

describe('quality governor', () => {
  test('a fast machine keeps full quality', () => {
    const g = new QualityGovernor({ shadows: true, pixelRatio: 2, minRatio: 0.75, now: 0 });
    expect(run(g, 4, 16.7, 120)).toEqual([]);
    expect(g.level).toBe(0);
  });

  test('a slow one steps down one notch at a time, shadows first, waiting between steps', () => {
    const g = new QualityGovernor({ shadows: true, pixelRatio: 2, minRatio: 0.75, now: 0 });
    const first = run(g, 16, 40, 6);
    expect(first).toEqual(['shadows/2']);
    const all = [...first, ...run(g, 16, 40, 120, 6000)];
    expect(all).toEqual(['shadows/2', 'pixels 1.5', 'shadows/4', 'pixels 1.13', 'pixels 0.85']);
    expect(g.remaining).toBe(0);
  });

  test('it never steps back up, so it cannot thrash', () => {
    const g = new QualityGovernor({ shadows: false, pixelRatio: 0.8, minRatio: 0.55, now: 0 });
    run(g, 20, 40, 6);
    const lvl = g.level;
    expect(lvl).toBe(1);
    expect(run(g, 2, 16.7, 60, 6000)).toEqual([]);
    expect(g.level).toBe(lvl);
  });

  test('the first seconds (shader warm-up) and a single spike do not count', () => {
    const g = new QualityGovernor({ shadows: true, pixelRatio: 1, minRatio: 0.75, now: 0 });
    expect(run(g, 80, 120, (GOV_SETTLE_MS - 10) / 1000)).toEqual([]);
    // One 600 ms frame in a window of fast ones: under budget on average.
    const steps: unknown[] = [];
    for (let i = 0; i < 400; i++) steps.push(g.sample(i === 5 ? 600 : 3, i === 5 ? 600 : 16.7, GOV_SETTLE_MS + i * 16.7));
    expect(steps.filter(Boolean)).toEqual([]);
  });
});
