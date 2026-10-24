import { CREST_PATTERNS, type CrestPattern } from '../meta/names.ts';

let uid = 0;

// Club data can come from outside (a peer in online play, an imported backup), so
// nothing reaches the markup unchecked: colours must be hex, the code is escaped.
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
const FALLBACK = '#8a8f98';
const safeColour = (v: unknown): string => (typeof v === 'string' && HEX.test(v) ? v : FALLBACK);
const esc = (t: string): string => t.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** A shield crest as inline SVG, drawn from the club's two colours and pattern. */
export function crestSvg(c: { primary: string; secondary: string; crest: CrestPattern; short: string }, size = 40): string {
  const id = `cr${++uid}`;
  const p = safeColour(c.primary);
  const s = safeColour(c.secondary);
  const pattern: CrestPattern = CREST_PATTERNS.includes(c.crest) ? c.crest : 'plain';
  const code = String(c.short ?? '').toUpperCase().slice(0, 3);
  const fills: Record<CrestPattern, string> = {
    plain: `<rect width="40" height="44" fill="${p}"/>`,
    stripes: `<rect width="40" height="44" fill="${p}"/>${[6, 18, 30].map((x) => `<rect x="${x}" width="5" height="44" fill="${s}"/>`).join('')}`,
    halves: `<rect width="20" height="44" fill="${p}"/><rect x="20" width="20" height="44" fill="${s}"/>`,
    sash: `<rect width="40" height="44" fill="${p}"/><path d="M-4 8 L8 -4 L44 32 L32 44 Z" fill="${s}"/>`,
    hoops: `<rect width="40" height="44" fill="${p}"/>${[8, 20, 32].map((y) => `<rect y="${y}" width="40" height="5" fill="${s}"/>`).join('')}`,
    chevron: `<rect width="40" height="44" fill="${p}"/><path d="M0 14 L20 26 L40 14 L40 22 L20 34 L0 22 Z" fill="${s}"/>`,
  };
  const shield = 'M3 3 H37 V20 C37 32 27 38 20 41 C13 38 3 32 3 20 Z';
  const textFill = pattern === 'plain' || pattern === 'sash' ? s : p;
  const textStroke = textFill === s ? p : s;
  // Three letters always fit inside the shield, whatever font loaded (the fallback is much wider).
  const fit = code.length >= 3 ? ' textLength="26" lengthAdjust="spacingAndGlyphs"' : '';
  return `<svg class="crest" width="${size}" height="${Math.round(size * 1.1)}" viewBox="0 0 40 44" aria-hidden="true">
    <defs><clipPath id="${id}"><path d="${shield}"/></clipPath></defs>
    <g clip-path="url(#${id})">${fills[pattern]}</g>
    <path d="${shield}" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-width="1.6"/>
    <text x="20" y="${pattern === 'hoops' ? 19 : 25}" text-anchor="middle" font-family="'Big Shoulders Display', 'Arial Narrow', sans-serif" font-weight="800" font-size="12"${fit}
      fill="${textFill}" stroke="${textStroke}" stroke-width="2.4" paint-order="stroke">${esc(code)}</text>
  </svg>`;
}
