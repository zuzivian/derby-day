// The 3D view's quality governor: when frames stay over budget on this machine, step the picture
// down one notch at a time (shadow refresh, then resolution), so play stays smooth on slow laptops
// and phones. A stall that passes (another tab busy, a GC storm) should not cost the rest of the
// match, so after a long stretch with plenty of headroom it steps back up one notch, once a match.
// It waits between steps for the last one to show its effect, and with that single step up it can
// never thrash between levels. Pure (times are passed in), for tests.

/** What the renderer draws at a level: the shadow map redrawn every `shadowEvery`-th frame, at `pixelRatio`. */
export interface GovernorState {
  level: number;
  shadowEvery: number;
  pixelRatio: number;
}

/** Average renderer CPU time per frame (draw(), including three's render submission) above this is over budget, ms. */
export const DRAW_BUDGET_MS = 10;
/** Average time between frames above this (under 25 fps; a 30 fps-capped phone stays under it) is over budget too: a GPU-bound or busy machine, ms. */
export const FRAME_BUDGET_MS = 40;
/** Each judgement averages this long of frames (and at least GOV_MIN_FRAMES of them), ms. */
export const GOV_WINDOW_MS = 2000;
export const GOV_MIN_FRAMES = 10;
/** After a step (and at the start), wait this long before judging again, ms. */
export const GOV_SETTLE_MS = 3000;
/** Step back up after this long of windows all under half of both budgets, ms. */
export const GOV_HEADROOM_MS = 10_000;
/** Steps back up allowed per match. */
export const GOV_MAX_UPS = 1;

export class QualityGovernor {
  /** Steps down in force now. */
  level = 0;
  /** Steps back up taken so far. */
  ups = 0;
  private draw = 0;
  private frame = 0;
  private n = 0;
  private windowStart = 0;
  /** Since when every window has had headroom (0: the last one did not). */
  private calmSince = 0;
  private settleUntil: number;
  private states: GovernorState[];

  /**
   * shadows: the view has a shadow map (high quality). pixelRatio: the starting resolution; it is not
   * taken below minRatio.
   */
  constructor(o: { shadows: boolean; pixelRatio: number; minRatio: number; now: number }) {
    this.settleUntil = o.now + GOV_SETTLE_MS;
    const states: GovernorState[] = [{ level: 0, shadowEvery: 1, pixelRatio: o.pixelRatio }];
    const push = (shadowEvery: number, pixelRatio: number) => states.push({ level: states.length, shadowEvery, pixelRatio });
    const top = () => states[states.length - 1];
    const lower = () => {
      const r = top().pixelRatio;
      const next = Math.max(o.minRatio, Math.round(r * 0.75 * 100) / 100);
      if (next < r - 0.01) push(top().shadowEvery, next);
    };
    if (o.shadows) push(2, top().pixelRatio);
    lower();
    if (o.shadows) push(4, top().pixelRatio);
    lower();
    lower();
    this.states = states;
  }

  /** Steps down still available. */
  get remaining(): number {
    return this.states.length - 1 - this.level;
  }

  /** The state for the current level. */
  get state(): GovernorState {
    return this.states[this.level];
  }

  /** Feed one frame: the renderer's CPU time and the time since the last frame, ms. Returns the new state when the level changes, else null. */
  sample(drawMs: number, frameMs: number, now: number): GovernorState | null {
    if (now < this.settleUntil) return null;
    if (!this.n) this.windowStart = now;
    // A frame after a hidden tab or a long stall says nothing about steady speed: cap it.
    this.draw += Math.min(drawMs, 100);
    this.frame += Math.min(frameMs, 100);
    if (++this.n < GOV_MIN_FRAMES || now - this.windowStart < GOV_WINDOW_MS) return null;
    const draw = this.draw / this.n;
    const frame = this.frame / this.n;
    this.draw = this.frame = this.n = 0;
    if (draw > DRAW_BUDGET_MS || frame > FRAME_BUDGET_MS) {
      this.calmSince = 0;
      if (this.remaining <= 0) return null;
      this.level++;
      this.settleUntil = now + GOV_SETTLE_MS;
      return this.state;
    }
    const calm = draw < DRAW_BUDGET_MS / 2 && frame < FRAME_BUDGET_MS / 2;
    if (!calm) {
      this.calmSince = 0;
      return null;
    }
    if (!this.calmSince) this.calmSince = this.windowStart;
    if (this.level === 0 || this.ups >= GOV_MAX_UPS || now - this.calmSince < GOV_HEADROOM_MS) return null;
    this.level--;
    this.ups++;
    this.calmSince = 0;
    this.settleUntil = now + GOV_SETTLE_MS;
    return this.state;
  }
}
