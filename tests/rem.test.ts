// Text size follows the browser's / OS text-size setting only if font sizes are rem and breakpoints are em.
// Guards the client's CSS (src/client/*.css and the styles injected from *.ts; r3d is canvas code) against a px font-size
// or a px media-query breakpoint creeping back. SVG attributes (font-size="10.5" in a viewBox) are not CSS and are not scanned.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../src/client/', import.meta.url).pathname;
const files = readdirSync(dir).filter((n) => /\.(css|ts|html)$/.test(n));

/** Every offending declaration or media condition in `src`, with its line number. */
function offences(src: string): string[] {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    // font-size: 14px, font-size: clamp(14px, 2vw, 22px), --fs-sm: 13px. A px floor as the last argument of max() is
    // allowed when the rest has no px (max(min(1rem, 5cqi), 16px)): the size still grows with the text, and the floor only
    // stops a container cap from shrinking it below its default size.
    const sized = line.replace(/max\(((?:[^;}()]|\((?:[^;}()]|\([^;}()]*\))*\))*?),\s*\d+(?:\.\d+)?px\)/g, (m, inner: string) => (/\dpx/.test(inner) ? m : `max(${inner})`));
    if (/(font-size|--fs-[\w-]+)\s*:[^;}]*\d(\.\d+)?px/.test(sized)) out.push(`${n}: px font size: ${line.trim()}`);
    // font: 700 12px/1.2 ...  (any px before the family)
    if (/(^|[\s;{"'])font\s*:[^;}"']*\d(\.\d+)?px/.test(line)) out.push(`${n}: px in font shorthand: ${line.trim()}`);
    // @media (max-width: 640px): em breakpoints follow the text size, px ones do not
    if (/\((min|max)-(width|height)\s*:\s*[\d.]+px\)/.test(line)) out.push(`${n}: px media query: ${line.trim()}`);
  });
  return out;
}

describe('text size follows the browser setting', () => {
  test('the scanner catches what it should', () => {
    expect(offences('a { font-size: 14px; }')).toHaveLength(1);
    expect(offences('a { font-size: clamp(14px, 2vw, 1rem); }')).toHaveLength(1);
    expect(offences('a { font: 700 12px/1.2 sans-serif; }')).toHaveLength(1);
    expect(offences('@media (max-width: 640px) { a { color: red; } }')).toHaveLength(1);
    expect(offences(':root { --fs-sm: 13px; }')).toHaveLength(1);
    expect(offences('a { font-size: .875rem; border: 1px solid; width: 20px; } @media (max-width: 40em) {}')).toHaveLength(0);
    expect(offences('/* font-size: 14px; */ a { color: red; }')).toHaveLength(0);
    expect(offences('a { font-size: max(min(1rem, 5cqi), 16px); }')).toHaveLength(0);
    expect(offences('a { font-size: max(14px, 16px); }')).toHaveLength(1);
    expect(offences('a { font-size: max(min(14px, 5cqi), 16px); }')).toHaveLength(1);
  });

  for (const f of files) {
    test(`${f} has no px font sizes or px breakpoints`, () => {
      expect(offences(readFileSync(dir + f, 'utf8'))).toEqual([]);
    });
  }
});
