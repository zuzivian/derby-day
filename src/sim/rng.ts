// Seeded PRNG (mulberry32). All randomness in the sim and the generators goes
// through this so a match can be replayed, or re-run on a server, from a seed
// plus the input log.

export interface Rng {
  s: number;
}

export function makeRng(seed: number): Rng {
  return { s: seed | 0 };
}

export function next(r: Rng): number {
  let t = (r.s = (r.s + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function range(r: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * next(r);
}

export function int(r: Rng, lo: number, hi: number): number {
  return lo + Math.floor(next(r) * (hi - lo + 1));
}

export function pick<T>(r: Rng, items: readonly T[]): T {
  return items[Math.floor(next(r) * items.length)];
}

export function chance(r: Rng, p: number): boolean {
  return next(r) < p;
}

/** Approximate standard normal (sum of three uniforms). */
export function gauss(r: Rng): number {
  return (next(r) + next(r) + next(r) - 1.5) * 2;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
