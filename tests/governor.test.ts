import { describe, expect, test } from 'bun:test';
import { GOV_SETTLE_MS, QualityGovernor } from '../src/client/r3d/governor.ts';

/** Run `secs` seconds of frames at a steady draw time and frame interval; returns the levels it moved to. */
function run(g: QualityGovernor, drawMs: number, frameMs: number, secs: number, t0 = 0) {
  const levels: string[] = [];
  for (let t = t0; t < t0 + secs * 1000; t += frameMs) {
    const st = g.sample(drawMs, frameMs, t);
    if (st) levels.push(`${st.level}:${st.shadowEvery}/${st.pixelRatio}`);
  }
  return levels;
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
    expect(first).toEqual(['1:2/2']);
    const all = [...first, ...run(g, 16, 40, 120, 6000)];
    expect(all).toEqual(['1:2/2', '2:2/1.5', '3:4/1.5', '4:4/1.13', '5:4/0.85']);
    expect(g.remaining).toBe(0);
  });

  test('after a passing stall it steps back up once, given 10 s of plenty of headroom', () => {
    const g = new QualityGovernor({ shadows: false, pixelRatio: 0.8, minRatio: 0.55, now: 0 });
    expect(run(g, 20, 40, 6)).toEqual(['1:1/0.6']);
    // Comfortable, but not with half the budget to spare: stays down.
    expect(run(g, 7, 25, 30, 6000)).toEqual([]);
    // Plenty of headroom: back up after about 10 s, and only once.
    expect(run(g, 2, 16.7, 30, 36_000)).toEqual(['0:1/0.8']);
    expect(g.ups).toBe(1);
  });

  test('a load that comes and goes cannot make it thrash: one step back up per match at most', () => {
    const g = new QualityGovernor({ shadows: true, pixelRatio: 1, minRatio: 0.75, now: 0 });
    const moves: string[] = [];
    let t = 0;
    for (let cycle = 0; cycle < 10; cycle++) {
      moves.push(...run(g, 20, 45, 8, t));
      t += 8000;
      moves.push(...run(g, 2, 16.7, 20, t));
      t += 20_000;
    }
    const ups = moves.filter((m, i) => i > 0 && Number(m[0]) < Number(moves[i - 1][0])).length;
    expect(ups).toBeLessThanOrEqual(1);
    // Three steps down exist here (shadows 1/2, resolution 0.75, shadows 1/4): every one, one up, one down again, then it stays put.
    expect(moves.length).toBeLessThanOrEqual(5);
    expect(run(g, 2, 16.7, 60, t)).toEqual([]);
  });

  test('the first seconds (shader warm-up) and a single spike do not count', () => {
    const g = new QualityGovernor({ shadows: true, pixelRatio: 1, minRatio: 0.75, now: 0 });
    expect(run(g, 80, 120, (GOV_SETTLE_MS - 10) / 1000)).toEqual([]);
    // One 600 ms frame among fast ones: under budget on average.
    const levels: unknown[] = [];
    for (let i = 0; i < 400; i++) levels.push(g.sample(i === 5 ? 600 : 3, i === 5 ? 600 : 16.7, GOV_SETTLE_MS + i * 16.7));
    expect(levels.filter(Boolean)).toEqual([]);
  });
});
