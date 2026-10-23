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
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-9) return dist(p, a);
  const t = clamp(dot(sub(p, a), ab) / l2, 0, 1);
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}
