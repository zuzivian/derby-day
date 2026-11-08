import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { minifyCss, optimizeCss, propKey } from '../scripts/css-min';

const opt = (s: string) => optimizeCss(minifyCss(s));

describe('optimizeCss value rules', () => {
  test('hex colours shorten only when every pair repeats', () => {
    expect(opt('a{color:#ffffff;background:#aabbcc;border-color:#112233cc;outline-color:#aabbccde}')).toBe('a{color:#fff;background:#abc;border-color:#123c;outline-color:#aabbccde}');
    expect(opt('a{color:#ffd60a}')).toBe('a{color:#ffd60a}');
  });
  test('hex-looking text inside url() and strings is left alone', () => {
    const s = `a{background:url("data:image/svg+xml,%3Csvg fill='#ffffff'/%3E");content:"#ffffff"}`;
    expect(opt(s)).toBe(minifyCss(s));
  });
  test('zero lengths lose their unit only for length properties, outside functions', () => {
    expect(opt('a{margin:0px auto;padding:0px 0px 4px;top:0px;border-radius:0px}')).toBe('a{margin:0 auto;padding:0 0 4px;top:0;border-radius:0}');
    expect(opt('a{width:calc(0px + 1px);margin:var(--x,0px);line-height:0px;transition:opacity 0s;flex:1 1 0px;box-shadow:0px 0px 4px red}')).toBe(
      'a{width:calc(0px + 1px);margin:var(--x,0px);line-height:0px;transition:opacity 0s;flex:1 1 0px;box-shadow:0px 0px 4px red}',
    );
    expect(opt('a{margin:10px;padding:.5px;width:100px;--gap:0px}')).toBe('a{margin:10px;padding:.5px;width:100px;--gap:0px}');
  });
  test('!important loses its space', () => {
    expect(opt('a{color:red !important}')).toBe('a{color:red!important}');
  });
  test('combinators lose their spaces, an+b arguments and strings keep theirs', () => {
    expect(opt('a > b + c ~ d{x:y}')).toBe('a>b+c~d{x:y}');
    expect(opt('li:nth-child(2n + 1) > a{x:y}')).toBe('li:nth-child(2n + 1)>a{x:y}');
    expect(opt(':is(a > b, c ~ d) e{x:y}')).toBe(':is(a>b,c~d) e{x:y}');
    expect(opt('[title="a > b"] > i{x:y}')).toBe('[title="a > b"]>i{x:y}');
    expect(opt('@media (min-width:600px){a{x:y}}')).toBe('@media (min-width:600px){a{x:y}}');
  });
});

describe('optimizeCss merging', () => {
  test('identical blocks join when nothing between declares those properties', () => {
    expect(opt('.a{display:none}.b{color:red}.c{display:none}')).toBe('.a,.c{display:none}.b{color:red}');
  });
  test('and stay apart when something between could override them', () => {
    const s = '.a{display:none}.b{display:flex}.c{display:none}';
    expect(opt(s)).toBe(s);
    const t = '.a{margin:0}.b{margin-top:4px}.c{margin:0}';
    expect(opt(t)).toBe(t);
    const u = '.a{top:0}.b{inset:1px}.c{top:0}';
    expect(opt(u)).toBe(u);
    const v = '.a{white-space:nowrap}.b{text-wrap:wrap}.c{white-space:nowrap}';
    expect(opt(v)).toBe(v);
  });
  test('an @media between blocks counts through its declarations; unknown at-rules are barriers', () => {
    const s = '.a{display:none}@media (max-width:5px){.x{display:flex}}.c{display:none}';
    expect(opt(s)).toBe(s);
    const t = '.a{color:red}@layer x{.x{color:blue}}.c{color:red}';
    expect(opt(t)).toBe(t);
    expect(opt('.a{color:red}@keyframes k{from{top:0}to{top:1px}}.c{color:red}')).toBe('.a,.c{color:red}@keyframes k{from{top:0}to{top:1px}}');
  });
  test('selectors a browser might drop as a whole are not merged', () => {
    const s = '.a::-webkit-scrollbar{width:0}.b{color:red}.c{width:0}';
    expect(opt(s)).toBe(s);
    const t = '.a{color:red}.b{width:0}.c:has(i){color:red}';
    expect(opt(t)).toBe(t);
  });
  test('same-condition @media blocks join under the same rule', () => {
    expect(opt('@media (a:b){.a{color:red}}.x{display:none}@media (a:b){.b{margin:0}}')).toBe('@media (a:b){.a{color:red}.b{margin:0}}.x{display:none}');
    const s = '@media (a:b){.a{color:red}}.x{color:blue}@media (a:b){.b{margin:0}}';
    expect(opt(s)).toBe('@media (a:b){.a{color:red}.b{margin:0}}.x{color:blue}');
    const t = '@media (a:b){.a{color:red}}.x{color:blue}@media (a:b){.b{color:green}}';
    expect(opt(t)).toBe(t);
  });
  test('propKey groups properties that share a cascade', () => {
    expect(propKey('margin-top')).toBe(propKey('margin'));
    expect(propKey('-webkit-line-clamp')).toBe(propKey('line-clamp'));
    expect(propKey('top')).toBe(propKey('inset-inline'));
    expect(propKey('line-height')).toBe(propKey('font-size'));
    expect(propKey('display')).not.toBe(propKey('color'));
  });
});

// ---- equivalence: flatten both stylesheets into (context, single selector, property, value) declarations ----
// For every declaration, its values must be unchanged (modulo the exact-value rewrites), and for properties that
// share a cascade the declarations must keep their relative order.

type Decl = { ctx: string; sel: string; prop: string; val: string; pos: number; sub: number };

function norm(val: string): string {
  return val
    .replace(/ ?!important$/i, '!important')
    .replace(/#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?(?![0-9a-z])/gi, (_m, a, b, c, d) => `#${a}${a}${b}${b}${c}${c}${d ? d + d : ''}`)
    .toLowerCase();
}
const normProp = (p: string, v: string) => (/^(margin|padding|inset|top|right|bottom|left|gap|row-gap|column-gap|width|height|min-width|min-height|max-width|max-height|outline-offset|border-radius|border-width|border-(top|right|bottom|left)-width|margin-.*|padding-.*|inset-.*)$/.test(p) && !v.includes('(') ? v.replace(/(^| )0(px|em|rem|vh|vw)(?= |$)/g, '$10') : v);
const normSel = (s: string) => s.replace(/\s*([>+~])\s*(?![^(]*\))/g, '$1').replace(/\s+/g, ' ').trim();

function split(s: string, ch: string): string[] {
  const out: string[] = [];
  let d = 0;
  let q = '';
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\') cur += s[++i];
      else if (c === q) q = '';
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === '(' || c === '[') {
      d++;
      cur += c;
    } else if (c === ')' || c === ']') {
      d--;
      cur += c;
    } else if (c === ch && d === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function flatten(css: string): Decl[] {
  const out: Decl[] = [];
  let pos = 0;
  const walk = (s: string, ctx: string): void => {
    let i = 0;
    while (i < s.length) {
      const o = s.indexOf('{', i);
      if (o < 0) break;
      let d = 0;
      let k = o;
      let q = '';
      for (; k < s.length; k++) {
        const c = s[k];
        if (q) {
          if (c === '\\') k++;
          else if (c === q) q = '';
        } else if (c === '"' || c === "'") q = c;
        else if (c === '{') d++;
        else if (c === '}' && --d === 0) break;
      }
      const head = s.slice(i, o).trim();
      const body = s.slice(o + 1, k);
      i = k + 1;
      if (/^@(media|supports)/.test(head)) walk(body, `${ctx}|${head}`);
      else if (head.startsWith('@')) continue;
      else {
        const sels = split(head, ',').map(normSel);
        const decls = split(body, ';').filter(Boolean);
        decls.forEach((dc, sub) => {
          const c = dc.indexOf(':');
          const prop = dc.slice(0, c).trim().toLowerCase();
          const val = normProp(prop, norm(dc.slice(c + 1).trim()));
          for (const sel of sels) out.push({ ctx, sel, prop, val, pos, sub });
        });
        pos++;
      }
    }
  };
  walk(css, '');
  return out;
}

const FILES = ['styles.css', 'review.css', 'replay.css', 'levels.css', 'hud.css', 'coach.css', 'platform.css', 'tactics.css'];

function checkEquivalent(before: string, after: string): void {
  const a = flatten(before);
  const b = flatten(after);
  expect(b.length).toBe(a.length);
  // 1. Same declarations per (context, selector, property), in the same order.
  const seq = (ds: Decl[]) => {
    const m = new Map<string, string[]>();
    for (const d of ds) {
      const key = `${d.ctx}\u0000${d.sel}\u0000${d.prop}`;
      (m.get(key) ?? m.set(key, []).get(key)!).push(d.val);
    }
    return m;
  };
  const sa = seq(a);
  const sb = seq(b);
  expect(sb.size).toBe(sa.size);
  for (const [k, v] of sa) expect(sb.get(k)).toEqual(v);
  // 2. Declarations whose properties share a cascade keep their relative order (the order in `before` is the
  //    order of the occurrence index inside each (selector, property); different selectors are ordered by position).
  const occ = (ds: Decl[]) => {
    const seen = new Map<string, number>();
    return ds.map((d) => {
      const key = `${d.ctx}\u0000${d.sel}\u0000${d.prop}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return { id: `${key}\u0000${n}`, d };
    });
  };
  const oa = occ(a);
  const posB = new Map(occ(b).map((x) => [x.id, x.d.pos]));
  const groups = new Map<string, { at: number; pb: number; pa: number; what: string }[]>();
  for (const x of oa) {
    const g = propKey(x.d.prop);
    (groups.get(g) ?? groups.set(g, []).get(g)!).push({ at: x.d.pos, pa: x.d.pos, pb: posB.get(x.id)!, what: `${x.d.ctx} ${x.d.sel}{${x.d.prop}:${x.d.val}}` });
  }
  for (const [g, list] of groups) {
    let last = -1;
    let lastWhat = '';
    for (const x of list) {
      // list is in the original order; the new positions must not go backwards across different rules.
      if (x.pb < last) throw new Error(`cascade order changed for ${g}: ${x.what} now comes before ${lastWhat}`);
      if (x.pb > last) {
        last = x.pb;
        lastWhat = x.what;
      }
    }
  }
}

describe('optimizeCss equivalence', () => {
  test('on small samples', () => {
    const s = '.a{display:none;margin:0px}.b{color:#ffffff}.c{display:none}@media (x:y){.d{top:0px}}.e{color:red}@media (x:y){.f{left:0px}}';
    checkEquivalent(minifyCss(s), optimizeCss(minifyCss(s)));
  });
  test('the checker notices a reordering that matters', () => {
    expect(() => checkEquivalent('.a{display:none}.b{display:flex}.c{display:none}', '.a,.c{display:none}.b{display:flex}')).toThrow();
  });
  test('on the real stylesheets', () => {
    const src = FILES.map((f) => readFileSync(new URL(`../src/client/${f}`, import.meta.url), 'utf8')).join('\n');
    const min = minifyCss(src);
    const out = optimizeCss(min);
    expect(out.length).toBeLessThan(min.length);
    checkEquivalent(min, out);
  });
});
