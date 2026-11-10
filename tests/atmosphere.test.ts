// Every time of day lights the pitch and the players about as the afternoon does (atmosphere.ts), so the
// kit-versus-grass readability model (kits.ts, fitted to afternoon screenshots) holds under the lights too.

import { describe, expect, test } from 'bun:test';
import { ATMOSPHERES, pickTimeOfDay, type Atmosphere } from '../src/client/r3d/atmosphere.ts';
import { Color, Vector3 } from '../src/client/r3d/three.ts';

type RGB = [number, number, number];

/** Diffuse light (linear RGB) on a surface with normal n, as three's hemisphere and directional lights give it. */
export function lightOn(a: Atmosphere, n: Vector3): RGB {
  const sky = new Color(a.hemi.sky);
  const ground = new Color(a.hemi.ground);
  const w = 0.5 * n.y + 0.5;
  const out: RGB = [0, 0, 0];
  const add = (c: Color, k: number) => {
    out[0] += c.r * k;
    out[1] += c.g * k;
    out[2] += c.b * k;
  };
  add(ground, a.hemi.intensity * (1 - w));
  add(sky, a.hemi.intensity * w);
  const dir = (p: [number, number, number]) => new Vector3(...p).normalize();
  add(new Color(a.key.color), a.key.intensity * Math.max(0, n.dot(dir(a.key.offset))));
  add(new Color(a.fill.color), a.fill.intensity * Math.max(0, n.dot(dir(a.fill.position))));
  return out;
}

/** The grass (facing up), and a shirt: the average over a player's sides as the broadcast camera sees them. */
export function grassAndShirt(a: Atmosphere): { grass: RGB; shirt: RGB } {
  const grass = lightOn(a, new Vector3(0, 1, 0));
  const sides = [new Vector3(0, 0.2, 1), new Vector3(1, 0.2, 0.4), new Vector3(-1, 0.2, 0.4), new Vector3(0.6, 0.2, 0.8), new Vector3(-0.6, 0.2, 0.8)].map((v) => lightOn(a, v.normalize()));
  const shirt = [0, 1, 2].map((k) => sides.reduce((t, s) => t + s[k], 0) / sides.length) as RGB;
  return { grass, shirt };
}

describe('time of day', () => {
  const day = grassAndShirt(ATMOSPHERES.day);
  for (const tod of ['dusk', 'night'] as const) {
    test(`${tod}: light on the grass and on a shirt within 10% of the afternoon's, channel by channel`, () => {
      const { grass, shirt } = grassAndShirt(ATMOSPHERES[tod]);
      for (let k = 0; k < 3; k++) {
        expect(grass[k] / day.grass[k]).toBeGreaterThan(0.9);
        expect(grass[k] / day.grass[k]).toBeLessThan(1.1);
        expect(shirt[k] / day.shirt[k]).toBeGreaterThan(0.9);
        expect(shirt[k] / day.shirt[k]).toBeLessThan(1.1);
      }
    });
  }

  test('a fixture keeps its time of day; ?tod= overrides it; all three come up across fixtures', () => {
    expect(pickTimeOfDay('Alpha', 'Beta')).toBe(pickTimeOfDay('Alpha', 'Beta'));
    expect(pickTimeOfDay('Alpha', 'Beta', 'night')).toBe('night');
    expect(pickTimeOfDay('Alpha', 'Beta', 'bogus')).toBe(pickTimeOfDay('Alpha', 'Beta'));
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(pickTimeOfDay(`Club ${i}`, `Rivals ${i * 7}`));
    expect([...seen].sort()).toEqual(['day', 'dusk', 'night']);
  });
});
