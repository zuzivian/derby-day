// Kit clashes, with colour-blind players in mind. Two kits clash when their shirts are hard to tell
// apart for normal vision, protanopia or deuteranopia (about 8% of men have one of the two red-green
// deficiencies). Colours are simulated with Machado, Oliveira & Fernandes (2009) at full severity in
// linear RGB, then compared with CIEDE2000. Pure: no DOM.
//
// Red-team round 1 found that the old plain-RGB test let about 1 in 10 pairings through that a
// red-green colour-blind player can't separate (crimson v green, red v green, green v orange).

import type { TeamSetup } from '../sim/types.ts';

type RGB = [number, number, number];

/** Below this CIEDE2000 difference between shirts, under any of the three visions, two kits clash. */
export const CLASH_DE = 20;

/** Machado 2009, severity 1.0, applied to linear RGB. */
const PROTAN = [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998];
const DEUTAN = [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881];

export type Vision = 'normal' | 'protan' | 'deutan';
export const VISIONS: Vision[] = ['normal', 'protan', 'deutan'];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function hexToLinear(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => toLinear(parseInt(full.slice(i, i + 2), 16) / 255)) as RGB;
}

function simulate(rgb: RGB, v: Vision): RGB {
  if (v === 'normal') return rgb;
  const m = v === 'protan' ? PROTAN : DEUTAN;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return [clamp(m[0] * rgb[0] + m[1] * rgb[1] + m[2] * rgb[2]), clamp(m[3] * rgb[0] + m[4] * rgb[1] + m[5] * rgb[2]), clamp(m[6] * rgb[0] + m[7] * rgb[1] + m[8] * rgb[2])];
}

/** Linear sRGB to CIE L*a*b* (D65). */
function toLab([r, g, b]: RGB): RGB {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference (Sharma, Wu and Dalal 2005). */
export function deltaE2000(a: RGB, b: RGB): number {
  const [L1, a1, b1] = a;
  const [L2, a2, b2] = b;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (bb: number, ap: number) => (bb === 0 && ap === 0 ? 0 : (Math.atan2(bb, ap) / rad + 360) % 360);
  const h1p = h(b1, a1p);
  const h2p = h(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lm = (L1 + L2) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hm = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hm = (h1p + h2p) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp;
  const Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/** How different two colours look under one kind of vision (CIEDE2000). */
export function colourDiff(a: string, b: string, v: Vision = 'normal'): number {
  return deltaE2000(toLab(simulate(hexToLinear(a), v)), toLab(simulate(hexToLinear(b), v)));
}

/** The smallest difference between two colours across normal, protan and deutan vision. */
export function worstDiff(a: string, b: string): number {
  return Math.min(...VISIONS.map((v) => colourDiff(a, b, v)));
}

/** Do two shirts clash for anyone (normal, protan or deutan vision)? */
export function shirtsClash(a: string, b: string): boolean {
  return worstDiff(a, b) < CLASH_DE;
}

export const NEUTRAL_DARK = '#1c1c1c';
export const NEUTRAL_LIGHT = '#f5f5f5';

/**
 * The away side's kit for this fixture: its own if the shirts are told apart under every vision,
 * else its colours swapped, else the neutral change kit (dark or light, whichever reads better
 * against the home shirt). Only these three, which is what online validation (src/net/validate.ts
 * kitOk) accepts. If none clears CLASH_DE, the one that reads best wins.
 */
export function avoidClash(home: TeamSetup, away: TeamSetup): TeamSetup {
  const swapped = { ...away, primary: away.secondary, secondary: away.primary };
  const darkOk = worstDiff(home.primary, NEUTRAL_DARK) >= worstDiff(home.primary, NEUTRAL_LIGHT);
  const neutral = { ...away, primary: darkOk ? NEUTRAL_DARK : NEUTRAL_LIGHT, secondary: darkOk ? NEUTRAL_LIGHT : NEUTRAL_DARK };
  const options = [away, swapped, neutral];
  for (const o of options) if (!shirtsClash(home.primary, o.primary)) return o;
  return options.reduce((best, o) => (worstDiff(home.primary, o.primary) > worstDiff(home.primary, best.primary) ? o : best));
}
