import { describe, expect, test } from 'bun:test';
import { crestSvg } from '../src/client/crest.ts';

describe('crestSvg', () => {
  test('draws a normal club', () => {
    const svg = crestSvg({ primary: '#c42b1e', secondary: '#fff', crest: 'stripes', short: 'abc' });
    expect(svg).toContain('fill="#c42b1e"');
    expect(svg).toContain('>ABC</text>');
  });

  test('hostile colours, code and pattern cannot inject markup', () => {
    const attack = '#fff" onload="alert(1)';
    const svg = crestSvg({
      primary: attack,
      secondary: 'red"/><script>alert(1)</script>',
      crest: '<img src=x onerror=alert(1)>' as never,
      short: '<svg/onload=alert(1)>',
    });
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<img');
    expect(svg).not.toContain('<svg/');
    expect(svg).toContain('#8a8f98'); // neutral fallback colour
    expect(svg).toContain('>&lt;SV</text>'); // uppercased, cut to 3, escaped
    // Exactly the elements the crest draws, nothing smuggled in.
    const tags = [...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(['svg', 'defs', 'clipPath', 'path', 'g', 'rect', 'text']));
  });
});
