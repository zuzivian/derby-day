export interface Vec {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
// sqrt rather than Math.hypot: several times faster, and sqrt is exactly specified by
// IEEE-754, so results match across browser engines (needed for rollback netcode later).
export const len = (a: Vec): number => Math.sqrt(a.x * a.x + a.y * a.y);
export const dist = (a: Vec, b: Vec): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};
export const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

export function norm(a: Vec): Vec {
  const l = Math.sqrt(a.x * a.x + a.y * a.y);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

export function rotate(a: Vec, rad: number): Vec {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** Distance from point p to segment ab. */
export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  return segDist(p.x, p.y, a.x, a.y, b.x, b.y);
}

/** distToSegment on plain numbers, for hot loops: the same arithmetic, no objects made. */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-9) {
    const dx = px - ax;
    const dy = py - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / l2, 0, 1);
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}
