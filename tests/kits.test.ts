// Kit clashes for colour-blind players (red-team round 1): every pairing of the ladder's kits must
// give two shirts that stay distinct under normal vision, protanopia and deuteranopia, using only
// the change kits online validation accepts.

import { describe, expect, test } from 'bun:test';
import { avoidClash, CLASH_DE, colourDiff, deltaE2000, GRASS, GRASS_DE, grassClash, grassDiff, NEUTRAL_DARK, NEUTRAL_LIGHT, shirtAsRendered, worstDiff, type Quality } from '../src/client/kits.ts';
import { keeperColors, PlayerKit } from '../src/client/r3d/player3d.ts';
import probe from './fixtures/kit-probe.json';
import { KIT_COLORS } from '../src/meta/names.ts';
import type { TeamSetup } from '../src/sim/types.ts';

const team = (primary: string, secondary: string): TeamSetup => ({ name: 'T', short: 'T', primary, secondary, players: [], aiSkill: 0.5 }) as unknown as TeamSetup;

describe('CIEDE2000', () => {
  test('matches the published test pairs (Sharma, Wu and Dalal 2005)', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE2000([50, -1.3802, -84.2814], [50, 0, -82.7485])).toBeCloseTo(1.0, 3);
    expect(deltaE2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 3);
    expect(deltaE2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(1.2644, 3);
  });
});

describe('colour-blind simulation', () => {
  test('red and green look alike to a protan, crimson and green to a deutan', () => {
    expect(colourDiff('#c8102e', '#166534', 'normal')).toBeGreaterThan(40);
    expect(colourDiff('#c8102e', '#166534', 'protan')).toBeLessThan(CLASH_DE);
    expect(colourDiff('#9f1239', '#166534', 'deutan')).toBeLessThan(CLASH_DE);
  });
});

describe('avoidClash', () => {
  test('every pairing of ladder kits is readable under normal, protan and deutan vision', () => {
    const bad: string[] = [];
    for (const [hp, hs] of KIT_COLORS) {
      for (const [ap, as] of KIT_COLORS) {
        const home = team(hp, hs);
        const away = avoidClash(home, team(ap, as));
        // Only the kits src/net/validate.ts kitOk allows.
        const allowed = [[ap, as], [as, ap], [NEUTRAL_DARK, NEUTRAL_LIGHT], [NEUTRAL_LIGHT, NEUTRAL_DARK]];
        expect(allowed.some(([p, q]) => p === away.primary && q === away.secondary)).toBe(true);
        const d = worstDiff(home.primary, away.primary);
        if (d < CLASH_DE) bad.push(`${hp} v ${ap} -> ${away.primary}: ${d.toFixed(1)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('keeps the away kit when it already reads well, and changes the red-green clashes', () => {
    const home = team('#1d3f8f', '#ffffff');
    expect(avoidClash(home, team('#c8102e', '#ffffff')).primary).toBe('#c8102e');
    const red = team('#c8102e', '#ffffff');
    expect(avoidClash(red, team('#166534', '#ffffff')).primary).not.toBe('#166534');
    const crimson = team('#9f1239', '#93c5fd');
    expect(avoidClash(crimson, team('#166534', '#ffffff')).primary).not.toBe('#166534');
  });
});

// Shirts against the grass (review of #19). tests/fixtures/kit-probe.json is scripts/kit-probe.cjs's
// reading of every ladder shirt as the 3D view draws it, at both quality levels (three near-black
// shirts left out, where the probe picked up shorts or grass instead of the shirt).
describe('shirts against the grass, as drawn', () => {
  const rows = probe as { quality: Quality; hex: string; drawn: string; grass: [string, string] }[];

  test('the grass colours are the ones the probe read off the screen', () => {
    for (const r of rows) expect(r.grass).toEqual(GRASS[r.quality]);
  });

  test('the lighting model gives every measured shirt within 7.5, and 3.5 on average (RMS), CIEDE2000', () => {
    for (const q of ['low', 'high'] as const) {
      const errs = rows.filter((r) => r.quality === q).map((r) => colourDiff(shirtAsRendered(r.hex, q), r.drawn));
      expect(errs.length).toBeGreaterThan(18);
      expect(Math.max(...errs)).toBeLessThan(7.5);
      expect(Math.sqrt(errs.reduce((n, e) => n + e * e, 0) / errs.length)).toBeLessThan(3.5);
    }
  });

  test('the model and the measurement agree on which shirts need the rim', () => {
    for (const r of rows) {
      const measured = Math.min(...r.grass.map((g) => worstDiff(r.drawn, g)));
      // Within a few units of the line either may fall on either side; elsewhere they must agree.
      if (Math.abs(measured - GRASS_DE) > 3) expect(grassDiff(r.hex, r.quality) < GRASS_DE).toBe(measured < GRASS_DE);
    }
  });

  test('red, green, yellow, amber, cream and orange shirts get the rim; blue, purple, black, white and the rest do not', () => {
    const clash = [...new Set([...KIT_COLORS.flat(), NEUTRAL_DARK, NEUTRAL_LIGHT])].filter(grassClash);
    expect(clash.sort()).toEqual(['#0b7a3e', '#c8102e', '#ea580c', '#f2a900', '#f4d03f', '#fde68a']);
  });

  test('keepers read against both shirts and the grass, for every pairing and every vision', () => {
    const bad: string[] = [];
    for (const [hp, hs] of KIT_COLORS) {
      for (const [ap, as] of KIT_COLORS) {
        const away = avoidClash(team(hp, hs), team(ap, as));
        for (const [own, other] of [
          [hp, away.primary],
          [away.primary, hp],
        ]) {
          const k = keeperColors(own, other).shirt;
          const d = Math.min(worstDiff(k, own), worstDiff(k, other), grassDiff(k, 'low'), grassDiff(k, 'high'));
          if (d < CLASH_DE) bad.push(`${own} v ${other}: keeper ${k} ${d.toFixed(1)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test('a rim kit gets its own player material, which darkens the silhouette', () => {
    const kit = new PlayerKit();
    const plain = kit.skinnedMat();
    const rim = kit.skinnedMat(true);
    expect(rim).not.toBe(plain);
    expect(kit.skinnedMat(true)).toBe(rim);
    const shader = { uniforms: {}, vertexShader: '', fragmentShader: 'void main() {\n#include <opaque_fragment>\n}' };
    (rim as unknown as { onBeforeCompile: (s: typeof shader) => void }).onBeforeCompile(shader);
    expect(shader.fragmentShader).toContain('rimEdge');
    expect(shader.fragmentShader).toContain('#include <opaque_fragment>');
    kit.dispose();
  });
});
