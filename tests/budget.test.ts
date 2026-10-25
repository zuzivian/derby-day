import { describe, expect, test } from 'bun:test';
import { budgetMs, FRAME_BUDGET, FRAME_PARTS } from '../src/client/r3d/budget.ts';
import { DRAW_BUDGET_MS } from '../src/client/r3d/governor.ts';

describe('3D frame budget', () => {
  test('each quality leaves the governor at least 2 ms before it steps down', () => {
    for (const q of ['low', 'high'] as const) expect(budgetMs(FRAME_BUDGET[q])).toBeLessThanOrEqual(DRAW_BUDGET_MS - 2);
  });

  test('low never allows more than high, part by part and on the GPU', () => {
    const lo = FRAME_BUDGET.low;
    const hi = FRAME_BUDGET.high;
    expect(lo.calls).toBeLessThanOrEqual(hi.calls);
    expect(lo.tris).toBeLessThanOrEqual(hi.tris);
    for (const k of FRAME_PARTS) expect(lo.ms[k]).toBeLessThanOrEqual(hi.ms[k]);
  });

  test('every part has a share', () => {
    for (const q of ['low', 'high'] as const) for (const k of FRAME_PARTS) expect(FRAME_BUDGET[q].ms[k]).toBeGreaterThan(0);
  });
});
