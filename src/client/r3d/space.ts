// World (sim) metres to scene units. The sim is 2D: x along the pitch from the
// home goal, y across it. The scene puts the pitch centre at the origin, x the
// same way, y up, and sim y on scene z, so a camera on the +z side looking
// toward -z sees sim x to the right and sim y downward, like the 2D view.

import { PITCH_H, PITCH_W } from '../../sim/constants.ts';

export const HALF_W = PITCH_W / 2;
export const HALF_H = PITCH_H / 2;
export const sx = (x: number): number => x - HALF_W;
export const sz = (y: number): number => y - HALF_H;
export const wx = (x: number): number => x + HALF_W;
export const wy = (z: number): number => z + HALF_H;

/** Big outdoor pitch (11 a side) rather than the indoor six-a-side arena. */
export const BIG_PITCH = PITCH_W >= 85;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Frame-rate independent exponential approach. */
export const damp = (a: number, b: number, rate: number, dt: number): number => a + (b - a) * (1 - Math.exp(-rate * dt));
/** Shortest signed angle from a to b. */
export const angleDelta = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** Small deterministic hash of a string to 0..1, for picking looks. */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
