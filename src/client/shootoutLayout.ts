// Geometry of the shootout canvas that must agree between drawing and tests: the goal, the
// LEFT/CENTRE/RIGHT dive labels on the grass below it, and the stand-off caption ("Kick 3 of 5" and
// the taker's name). The caption used to sit at a fixed 56% of the height, which on a short landscape
// canvas is right on top of the labels.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GoalGeom {
  l: number;
  t: number;
  w: number;
  h: number;
  b: number;
  r: number;
}

export function goalGeom(W: number, H: number): GoalGeom {
  const w = Math.min(W * (W < 520 ? 0.78 : 0.66), H * 1.3); // a phone gets a bigger goal to aim at
  const h = w * 0.42;
  const l = (W - w) / 2;
  const t = H * 0.09;
  return { l, t, w, h, b: t + h, r: l + w };
}

/** Font size and centre line of the dive labels (they sit on the grass below the goal line). */
export function labelGeom(W: number, H: number): { size: number; y: number } {
  const g = goalGeom(W, H);
  return { size: Math.max(12, H * 0.034), y: g.b + Math.max(14, g.h * 0.2) };
}

/** Boxes of the three dive labels, padded for their outline. Width is generous: "CENTRE" at ~3.6 em. */
export function labelBoxes(W: number, H: number): Rect[] {
  const g = goalGeom(W, H);
  const { size, y } = labelGeom(W, H);
  const third = g.w / 3;
  const w = size * 3.6 + 4;
  return [0, 1, 2].map((k) => ({ x: g.l + third * (k + 0.5) - w / 2, y: y - size / 2 - 2, w, h: size + 4 }));
}

export interface CaptionGeom {
  /** Centre line of the headline. */
  y: number;
  /** Headline and taker-name font sizes (px), and the taker line's offset below the headline. */
  titleSize: number;
  nameSize: number;
  nameOffset: number;
}

/** Caption boxes (headline, taker name), for a headline of `chars` letters and a name of `nameChars`. */
export function captionBoxes(W: number, c: CaptionGeom, chars = 12, nameChars = 18): Rect[] {
  const tw = Math.min(W, c.titleSize * 0.55 * chars);
  const nw = Math.min(W, c.nameSize * 0.55 * nameChars);
  return [
    { x: (W - tw) / 2, y: c.y - c.titleSize / 2, w: tw, h: c.titleSize },
    { x: (W - nw) / 2, y: c.y + c.nameOffset - c.nameSize / 2, w: nw, h: c.nameSize },
  ];
}

/**
 * Where the stand-off caption goes. It keeps its usual place (56% down) when that clears the dive
 * labels; on a short canvas it moves below them and, if the canvas then runs out, shrinks to fit.
 */
export function captionGeom(W: number, H: number): CaptionGeom {
  const lbl = labelGeom(W, H);
  const clearTop = lbl.y + lbl.size / 2 + 6; // the caption must start below this
  const limit = H - 4;
  let best: CaptionGeom | null = null;
  for (let s = 1; s >= 0.45; s -= 0.05) {
    const titleSize = Math.max(24, H * 0.1) * s;
    const nameSize = Math.max(13, H * 0.045) * s;
    const nameOffset = H * 0.085 * s;
    const y = Math.max(H * 0.56, clearTop + titleSize / 2);
    best = { y, titleSize, nameSize, nameOffset };
    if (y + nameOffset + nameSize / 2 <= limit) break;
  }
  return best!;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
