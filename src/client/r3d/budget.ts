// The 3D view's frame budget, per quality: what one draw() may spend on the CPU, part by part, and
// what it may hand the GPU (draw calls, triangles). New view work (stadium, lighting, celebrations)
// fits inside its part's share. The governor (governor.ts) steps quality down on a machine whose
// average draw() is over DRAW_BUDGET_MS, so the CPU totals sit below that, leaving it headroom.
// renderer3d.ts publishes what each part actually took on the canvas (data-parts, data-calls,
// data-tris) once a second, and tests/e2e/perf.e2e.cjs holds the GPU counts to these numbers.

import type { Quality } from './renderer3d.ts';

/** The parts of a frame, in draw() order. */
export const FRAME_PARTS = ['setup', 'players', 'stadium', 'scene', 'submit'] as const;
export type FramePart = (typeof FRAME_PARTS)[number];

export interface FrameBudget {
  /**
   * CPU ms per frame for each part, on the machine the numbers were taken on (see below):
   * setup: the director, cards and per-frame state; players: the 22 figures, the referee, the ball;
   * stadium: crowd, flags, nets; scene: camera, shadow framing, aim and markers; submit: three's
   * render call, the shadow pass included (so lighting lands here).
   */
  ms: Record<FramePart, number>;
  /** Draw calls per frame, at most (three's info.render.calls). */
  calls: number;
  /** Triangles per frame, at most. */
  tris: number;
}

// Taken on the dev container (headless Chromium, SwiftShader, 4 cores), governor off, over open play
// and a goal with its celebration and replay (2026-10-25). Per frame, max seen:
//   low:  players 1.3, stadium 0.1, scene 0.5, submit 2.8 ms; 115 calls (the goal replay); 155k tris.
//   high: players 1.7, stadium 0.4, scene 0.5, submit 4.1 ms; 154 calls; 432k tris.
// The totals leave the governor 4 (low) and 2 (high) ms before it steps down; players and stadium get
// the most room over what is spent today, since celebrations land there. GPU counts: about 20% over.
export const FRAME_BUDGET: Record<Quality, FrameBudget> = {
  low: { ms: { setup: 0.3, players: 1.7, stadium: 0.6, scene: 0.5, submit: 2.9 }, calls: 140, tris: 190_000 },
  high: { ms: { setup: 0.3, players: 2.1, stadium: 0.9, scene: 0.6, submit: 4.1 }, calls: 190, tris: 520_000 },
};

/** The CPU total of a budget, ms. */
export const budgetMs = (b: FrameBudget): number => FRAME_PARTS.reduce((t, k) => t + b.ms[k], 0);
