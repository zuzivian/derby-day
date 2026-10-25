// The 3D view's quality governor: when frames stay over budget on this machine, step the picture
// down one notch at a time (shadow refresh, then resolution), so play stays smooth on slow laptops
// and phones. It only ever steps down, and waits between steps for the last one to show its effect,
// so it never thrashes between levels. Pure (times are passed in), for tests.

/** One notch down: refresh the sun's shadow map less often, or draw at a lower resolution. */
export type GovernorStep = { kind: 'shadows'; every: number } | { kind: 'pixels'; ratio: number };

/** Average renderer CPU time per frame (draw(), including three's render submission) above this is over budget, ms. */
export const DRAW_BUDGET_MS = 10;
/** Average time between frames above this (under 25 fps; a 30 fps-capped phone stays under it) is over budget too: a GPU-bound or busy machine, ms. */
export const FRAME_BUDGET_MS = 40;
/** Each judgement averages this long of frames (and at least GOV_MIN_FRAMES of them), ms. */
export const GOV_WINDOW_MS = 2000;
export const GOV_MIN_FRAMES = 10;
/** After a step (and at the start), wait this long before judging again, ms. */
export const GOV_SETTLE_MS = 3000;

export class QualityGovernor {
  /** Steps taken so far. */
  level = 0;
  private draw = 0;
  private frame = 0;
  private n = 0;
  private windowStart = 0;
  private settleUntil: number;
  private steps: GovernorStep[];

  /**
   * shadows: the view has a shadow map (high quality). pixelRatio: the starting resolution; it is not
   * taken below minRatio.
   */
  constructor(o: { shadows: boolean; pixelRatio: number; minRatio: number; now: number }) {
    this.settleUntil = o.now + GOV_SETTLE_MS;
    const steps: GovernorStep[] = [];
    let r = o.pixelRatio;
    const lower = () => {
      const next = Math.max(o.minRatio, Math.round(r * 0.75 * 100) / 100);
      if (next < r - 0.01) steps.push({ kind: 'pixels', ratio: (r = next) });
    };
    if (o.shadows) steps.push({ kind: 'shadows', every: 2 });
    lower();
    if (o.shadows) steps.push({ kind: 'shadows', every: 4 });
    lower();
    lower();
    this.steps = steps;
  }

  /** Steps still available. */
  get remaining(): number {
    return this.steps.length - this.level;
  }

  /** Feed one frame: the renderer's CPU time and the time since the last frame, ms. Returns a step to apply, or null. */
  sample(drawMs: number, frameMs: number, now: number): GovernorStep | null {
    if (now < this.settleUntil || this.level >= this.steps.length) return null;
    if (!this.n) this.windowStart = now;
    // A frame after a hidden tab or a long stall says nothing about steady speed: cap it.
    this.draw += Math.min(drawMs, 100);
    this.frame += Math.min(frameMs, 100);
    if (++this.n < GOV_MIN_FRAMES || now - this.windowStart < GOV_WINDOW_MS) return null;
    const over = this.draw / this.n > DRAW_BUDGET_MS || this.frame / this.n > FRAME_BUDGET_MS;
    this.draw = this.frame = this.n = 0;
    if (!over) return null;
    this.settleUntil = now + GOV_SETTLE_MS;
    return this.steps[this.level++];
  }
}
