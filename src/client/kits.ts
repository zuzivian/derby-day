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

// ---------------------------------------------------------------------------
// Shirts against the grass. The 3D view lights and tone-maps everything, so a shirt is compared with
// the grass as both are drawn, not as their hex codes: the grass colours were read back from the
// game's own screenshots, and a shirt's drawn colour comes from a model of the lighting and the
// ACES tone mapping (shirtAsRendered) fitted to screenshots of every ladder shirt
// (scripts/kit-probe.cjs; tests/kits.test.ts checks the fit).

export type Quality = 'low' | 'high';

/** The grass as the 3D view draws it: the dark and the light mowing stripe, per quality level. */
export const GRASS: Record<Quality, [string, string]> = {
  low: ['#84a147', '#92ae57'],
  high: ['#85a148', '#92af57'],
};

/** Below this CIEDE2000 difference from a grass stripe, under any vision, a shirt needs the dark rim. */
export const GRASS_DE = 20;

/** Light on a player's shirt, linear RGB before exposure (sun, sky and the green bounce off the grass), fitted per quality. */
export const SHIRT_LIGHT: Record<Quality, RGB> = {
  low: [0.559, 0.627, 0.564],
  high: [0.566, 0.639, 0.588],
};

/** The renderer's tone mapping exposure (renderer3d.ts). */
const EXPOSURE = 1.05;

/** three.js's ACESFilmicToneMapping, on linear RGB. */
function aces([r, g, b]: RGB): RGB {
  const k = EXPOSURE / 0.6;
  const i = [r * k, g * k, b * k];
  const v = [0.59719 * i[0] + 0.35458 * i[1] + 0.04823 * i[2], 0.076 * i[0] + 0.90834 * i[1] + 0.01566 * i[2], 0.0284 * i[0] + 0.13383 * i[1] + 0.83777 * i[2]];
  const f = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
  const o = [1.60475 * f[0] - 0.53108 * f[1] - 0.07367 * f[2], -0.10208 * f[0] + 1.10813 * f[1] - 0.00605 * f[2], -0.00327 * f[0] - 0.07276 * f[1] + 1.07602 * f[2]];
  return o.map((x) => Math.max(0, Math.min(1, x))) as RGB;
}

const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const toHex = (rgb: RGB) => '#' + rgb.map((c) => Math.round(toSrgb(c) * 255).toString(16).padStart(2, '0')).join('');

/** A shirt colour as the 3D view draws it, lit and tone-mapped, at this quality level. */
export function shirtAsRendered(hex: string, quality: Quality): string {
  const lin = hexToLinear(hex);
  const e = SHIRT_LIGHT[quality];
  return toHex(aces([lin[0] * e[0], lin[1] * e[1], lin[2] * e[2]]));
}

/** How far a shirt is, as drawn, from the nearer grass stripe, under the worst of the three visions. */
export function grassDiff(shirt: string, quality: Quality): number {
  const drawn = shirtAsRendered(shirt, quality);
  return Math.min(...GRASS[quality].map((g) => worstDiff(drawn, g)));
}

/** Is this shirt too close to the grass (at either quality level) to read without a dark rim? */
export function grassClash(shirt: string): boolean {
  return grassDiff(shirt, 'low') < GRASS_DE || grassDiff(shirt, 'high') < GRASS_DE;
}
