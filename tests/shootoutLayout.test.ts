import { describe, expect, test } from 'bun:test';
import { captionBoxes, captionGeom, goalGeom, labelBoxes, overlaps } from '../src/client/shootoutLayout.ts';

// Canvas sizes the shootout really gets: iPhone 13 portrait (4:3 and 1:1), short landscape phones, desktop.
const SIZES: [string, number, number][] = [
  ['iPhone 13 portrait 4:3', 358, 268],
  ['iPhone 13 portrait 1:1', 358, 358],
  ['750x342 landscape', 430, 326],
  ['667x375 landscape', 410, 359],
  ['568x320 landscape', 330, 304],
  ['desktop', 820, 512],
];

describe('shootout canvas layout', () => {
  for (const [name, W, H] of SIZES) {
    test(`caption never touches the dive labels or leaves the canvas: ${name}`, () => {
      const c = captionGeom(W, H);
      const boxes = captionBoxes(W, c);
      for (const lb of labelBoxes(W, H)) for (const cb of boxes) expect(overlaps(cb, lb)).toBe(false);
      for (const cb of boxes) {
        expect(cb.y).toBeGreaterThanOrEqual(0);
        expect(cb.y + cb.h).toBeLessThanOrEqual(H);
      }
      expect(c.titleSize).toBeGreaterThanOrEqual(14);
    });
  }

  test('the goal is the one the shootout draws', () => {
    const g = goalGeom(400, 300);
    expect(g.r - g.l).toBe(g.w);
    expect(g.b).toBeCloseTo(g.t + g.h);
  });
});
