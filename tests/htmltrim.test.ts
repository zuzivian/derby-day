import { describe, expect, test } from 'bun:test';
import { trimTemplateWhitespace } from '../scripts/html-trim.ts';

const trim = (s: string): string => trimTemplateWhitespace(s).out;

describe('html template whitespace trim', () => {
  test('collapses a newline run between tags to one space', () => {
    expect(trim('const a = `<ul>\n    <li>x</li>\n    <li>y</li>\n  </ul>`;')).toBe('const a = `<ul> <li>x</li> <li>y</li> </ul>`;');
  });
  test('keeps :empty-ness: a whitespace-only node stays a node', () => {
    expect(trim('x = `<p class="result-note">\n</p>`')).toBe('x = `<p class="result-note"> </p>`');
  });
  test('leaves runs without a newline, and text around them, alone', () => {
    const s = 'x = `<b>a</b> <i>b</i>\n text <u>c</u>`';
    expect(trim(s)).toBe(s);
  });
  test('does nothing next to a substitution', () => {
    const s = 'x = `<ul>\n  ${items}\n</ul>`';
    expect(trim(s)).toBe(s);
  });
  test('trims on both sides of a substitution that sits inside an element', () => {
    expect(trim('x = `<ul>\n  <li>${a}</li>\n  <li>${b}</li>\n</ul>`')).toBe('x = `<ul> <li>${a}</li> <li>${b}</li> </ul>`');
  });
  test('skips templates with textarea, pre, script or style, and white-space styles', () => {
    for (const t of ['<textarea>\n</textarea>\n<p>a</p>\n<p>b</p>', '<pre>a</pre>\n<p>b</p>', '<style>a{}</style>\n<p>b</p>', '<p style="white-space:pre">a</p>\n<p>b</p>']) {
      const s = `x = \`<div>\n  ${t}\n</div>\``;
      expect(trim(s)).toBe(s);
    }
  });
  test('does not touch ">" or "<" inside attribute values or comments', () => {
    const s = 'x = `<a title="a>\n<b" href="#">t</a><!-- <p>\n<p> --><br>`';
    expect(trim(s)).toBe(s);
  });
  test('skips tagged templates and templates that are not HTML', () => {
    const tagged = 'x = html`<p>a</p>\n  <p>b</p>`';
    expect(trim(tagged)).toBe(tagged);
    const css = 'x = `a > b {\n  color: red;\n}\nc < d`';
    expect(trim(css)).toBe(css);
    const code = 'if (a > b) x = `plain\n  text` ; if (c < d) y = 1;';
    expect(trim(code)).toBe(code);
  });
  test('is not fooled by strings, comments, regexes and nested templates around the template', () => {
    const quoted = "const re = /[`'\"]>\\s*</g; // `<p>\n<p>`";
    expect(trim(quoted)).toBe(quoted);
    const str = "const s = '`<p>\\n<p>`'; /* `<p>\n<p>` */";
    expect(trim(str)).toBe(str);
    expect(trim('const n = `<div>\n  ${`<i>\n<b>x</b>\n</i>`}\n  <p>y</p>\n</div>`;')).toBe('const n = `<div>\n  ${`<i> <b>x</b> </i>`}\n  <p>y</p> </div>`;');
    // after a regex containing a backtick, the next template is still found
    expect(trim('const r = /`/; const t = `<p>a</p>\n<p>b</p>`;')).toBe('const r = /`/; const t = `<p>a</p> <p>b</p>`;');
  });
  test('only ever changes whitespace', () => {
    const src = 'const a = `<div>\n\t<span>1</span>\n\n\t<span>2</span>\n</div>`;\nconst b = `<i></i>   \n   <i></i>`;';
    expect(trim(src).replace(/\s+/g, '')).toBe(src.replace(/\s+/g, ''));
  });
});

// The trim collapses newline runs between tags to one space, which only renders the same where white-space collapses.
// It cannot see styles set in a stylesheet, so a pre/pre-wrap/pre-line/break-spaces rule in the client CSS must fail here
// until the trim learns to skip the templates it styles.
test('no client stylesheet preserves whitespace that the template trim collapses', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../src/client/', import.meta.url).pathname;
  const hits = readdirSync(dir)
    .filter((n) => /\.(css|ts)$/.test(n))
    .flatMap((n) => (readFileSync(dir + n, 'utf8').match(/white-space\s*:\s*(pre|pre-wrap|pre-line|break-spaces)\b/g) || []).map((m) => `${n}: ${m}`));
  expect(hits).toEqual([]);
});
