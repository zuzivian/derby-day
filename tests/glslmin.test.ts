import { describe, expect, test } from 'bun:test';
import { minifyGlslStrings, minifyGlslTemplates } from '../scripts/glsl-min';

describe('build-time GLSL shrink', () => {
  test('strips indentation after escaped newlines in GLSL string constants only', () => {
    const src = 'const a = "#ifdef X\\n\\tfloat y = 1.0;\\n\\t\\t#include <foo>\\n#endif";\nconst b = "hello\\n\\tworld";';
    const out = minifyGlslStrings(src);
    expect(out).toContain('"#ifdef X\\nfloat y = 1.0;\\n#include <foo>\\n#endif"');
    expect(out).toContain('"hello\\n\\tworld"'); // not GLSL: untouched
  });
  test('leaves a template alone when it holds a comment or an interpolation', () => {
    const withComment = '/* glsl */`\n\t// note\n\tvoid main() {}\n`';
    const withExpr = '/* glsl */`\n\tuniform float ${n};\n`';
    expect(minifyGlslTemplates(withComment)).toBe(withComment);
    expect(minifyGlslTemplates(withExpr)).toBe(withExpr);
  });
  test('trims lines and drops blank ones in a plain glsl template', () => {
    expect(minifyGlslTemplates('x = /* glsl */`\n\tvoid main() {\n\n\t\tgl_FragColor = c;\n\t}\n`;')).toBe('x = /* glsl */`\nvoid main() {\ngl_FragColor = c;\n}\n`;');
  });
});
