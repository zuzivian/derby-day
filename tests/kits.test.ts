// Kit clashes for colour-blind players (red-team round 1): every pairing of the ladder's kits must
// give two shirts that stay distinct under normal vision, protanopia and deuteranopia, using only
// the change kits online validation accepts.

import { describe, expect, test } from 'bun:test';
import { avoidClash, CLASH_DE, colourDiff, deltaE2000, NEUTRAL_DARK, NEUTRAL_LIGHT, worstDiff } from '../src/client/kits.ts';
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
