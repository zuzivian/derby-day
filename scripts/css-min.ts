/**
 * Build-time CSS minify: drops comments and collapses whitespace; the sources in the repo keep their comments.
 * It scans token by token so strings ('...', "..."), url(...) bodies and anything inside them (data: SVGs,
 * content: values) are copied verbatim. Whitespace is removed only around { } ; , and after ':' (never before it,
 * since "a :hover" and "a:hover" differ), so selectors, @media/@supports conditions, calc() and custom
 * properties keep their meaning.
 */
export function minifyCss(src: string): string {
  let out = '';
  const n = src.length;
  let i = 0;
  let space = false;
  const put = (t: string): void => {
    if (space && out && !/[{};,:]$/.test(out) && !/^[{};,]/.test(t)) out += ' ';
    space = false;
    out += t;
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      space = true;
    } else if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      i++;
      space = true;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      put(src.slice(i, j + 1));
      i = j + 1;
    } else if (c === ':' && space && out && !/[{};,:(]$/.test(out)) {
      out += ' :';
      space = false;
      i++;
    } else if (c === '{' || c === ';' || c === ',' || c === ':') {
      out += c;
      space = false;
      i++;
    } else if (c === '}') {
      out = out.replace(/;$/, '') + '}';
      space = false;
      i++;
    } else if (src.startsWith('url(', i)) {
      let j = i + 4;
      let q = '';
      while (j < n && (q || src[j] !== ')')) {
        if (q) {
          if (src[j] === q) q = '';
        } else if (src[j] === '"' || src[j] === "'") q = src[j];
        j++;
      }
      put(src.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i + 1;
      while (j < n && !' \n\t\r"\'{};,:}/'.includes(src[j]) && !src.startsWith('url(', j)) j++;
      if (j === i + 1 && src[j - 1] === '/') j = i + 1;
      put(src.slice(i, j));
      i = j;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// optimizeCss: structural clean-up of already-minified CSS. Every rule here keeps the cascade intact.
//  - #rrggbb -> #rgb (and #rrggbbaa -> #rgba) when each pair repeats a digit: the same colour, exactly.
//  - 0px (and other lengths) -> 0 for properties that take a <length> and are not shorthands with times/numbers.
//  - " > ", " + ", " ~ " in selectors lose their spaces; " !important" loses its space.
//  - Rules with an identical declaration block become one rule with a selector list, and @media / @supports
//    blocks with the same condition become one block, but only when everything between the two places
//    declares none of the properties involved (so the cascade order between conflicting declarations is
//    unchanged), and never for selectors a browser that lacks one of them would drop as a whole.
// ---------------------------------------------------------------------------------------------------------

type Node =
  | { k: 'rule'; sel: string; decls: string[] }
  | { k: 'group'; pre: string; kids: Node[] } // @media / @supports
  | { k: 'raw'; text: string; barrier: boolean };

function scan(src: string, from: number, stops: string): number {
  // Index of the first char in `stops` at paren/bracket/string depth 0, or src.length.
  let d = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
    } else if (c === '(' || c === '[') d++;
    else {
      if (c === ')' || c === ']') d--;
      if (d <= 0 && stops.includes(c)) return i;
    }
  }
  return src.length;
}

function matchBrace(src: string, open: number): number {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
    } else if (c === '{') d++;
    else if (c === '}' && --d === 0) return i;
  }
  return src.length;
}

function parseNodes(src: string): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < src.length) {
    const stop = scan(src, i, '{;');
    if (stop >= src.length) {
      out.push({ k: 'raw', text: src.slice(i), barrier: true });
      break;
    }
    if (src[stop] === ';') {
      out.push({ k: 'raw', text: src.slice(i, stop + 1), barrier: true });
      i = stop + 1;
      continue;
    }
    const head = src.slice(i, stop);
    const end = matchBrace(src, stop);
    const body = src.slice(stop + 1, end);
    i = end + 1;
    if (/^@(media|supports)\b/.test(head)) out.push({ k: 'group', pre: head, kids: parseNodes(body) });
    else if (head[0] === '@') out.push({ k: 'raw', text: `${head}{${body}}`, barrier: !/^@(keyframes|-webkit-keyframes|font-face|property)\b/.test(head) });
    else {
      const decls: string[] = [];
      let j = 0;
      while (j < body.length) {
        const e = scan(body, j, ';');
        if (e > j) decls.push(body.slice(j, e));
        j = e + 1;
      }
      out.push({ k: 'rule', sel: head, decls });
    }
  }
  return out;
}

function emit(nodes: Node[]): string {
  let s = '';
  for (const n of nodes) s += n.k === 'rule' ? `${n.sel}{${n.decls.join(';')}}` : n.k === 'group' ? `${n.pre}{${emit(n.kids)}}` : n.text;
  return s;
}

/** Properties that interact in the cascade share a key; unrelated ones (display vs color) do not. */
export function propKey(prop: string): string {
  const p = prop.replace(/^-(webkit|moz|ms|o)-/, '');
  if (p.startsWith('--')) return p;
  if (p === 'all') return '*';
  if (/^(inset|top|right|bottom|left)(-|$)/.test(p)) return 'inset';
  if (/^(width|height|inline-size|block-size|min-|max-)/.test(p)) return 'size';
  if (/^(place|align|justify)-/.test(p)) return 'align';
  if (/^(gap|row-gap|column-gap|grid-gap)$/.test(p)) return 'gap';
  if (/^(white-space|text-wrap|word-wrap|overflow-wrap)/.test(p)) return 'wrap';
  if (/^(line-height|font)/.test(p)) return 'font';
  return p.split('-')[0];
}

function keysOf(n: Node, into = new Set<string>()): Set<string> {
  if (n.k === 'rule') for (const d of n.decls) into.add(propKey(d.slice(0, d.indexOf(':')).trim().toLowerCase()));
  else if (n.k === 'group') for (const c of n.kids) keysOf(c, into);
  else if (n.barrier) into.add('*');
  return into;
}

const overlaps = (a: Set<string>, b: Set<string>): boolean => {
  if (a.has('*') || b.has('*')) return true;
  for (const k of a) if (b.has(k)) return true;
  return false;
};

// A selector a browser might not understand drops the whole list it is in, so such rules are never merged.
const RISKY_SELECTOR = /:-|:has\(|:user-|:modal|:popover|:host|:autofill|:state\(|:dir\(|:nth-[a-z-]+\([^)]* of /;

function mergeNodes(nodes: Node[]): Node[] {
  // Recurse first, so the groups' contents are tidy before groups are compared.
  for (const n of nodes) if (n.k === 'group') n.kids = mergeNodes(n.kids);
  const live: (Node | null)[] = nodes.slice();
  const keys = nodes.map((n) => keysOf(n));
  const anchorRule = new Map<string, number>();
  const anchorGroup = new Map<string, number>();
  for (let b = 0; b < live.length; b++) {
    const nb = live[b];
    if (!nb) continue;
    let anchors: Map<string, number> | null = null;
    let id = '';
    if (nb.k === 'rule' && !RISKY_SELECTOR.test(nb.sel) && nb.decls.length) {
      anchors = anchorRule;
      id = nb.decls.join(';');
    } else if (nb.k === 'group') {
      anchors = anchorGroup;
      id = nb.pre;
    }
    if (!anchors) continue;
    const a = anchors.get(id);
    if (a !== undefined) {
      let free = true;
      for (let m = a + 1; m < b && free; m++) if (live[m] && overlaps(keys[b], keys[m])) free = false;
      if (free) {
        const na = live[a]!;
        if (na.k === 'rule' && nb.k === 'rule') na.sel += `,${nb.sel}`;
        else if (na.k === 'group' && nb.k === 'group') {
          na.kids = mergeNodes([...na.kids, ...nb.kids]);
          keys[a] = keysOf(na);
        }
        live[b] = null;
        continue;
      }
    }
    anchors.set(id, b);
  }
  return live.filter((n): n is Node => n !== null);
}

const SHORT_HEX = /#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3(?:([0-9a-f])\4)?(?![0-9a-zA-Z_-])/gi;
// Properties whose every value is a <length>/<percentage> list (a bare 0 is a legal length there).
const LENGTH_PROP = /^(margin|padding|inset|top|right|bottom|left|gap|row-gap|column-gap|width|height|min-width|min-height|max-width|max-height|outline-offset|border-radius|border-width|border-(top|right|bottom|left)-width|margin-(top|right|bottom|left|inline|block)(-start|-end)?|padding-(top|right|bottom|left|inline|block)(-start|-end)?|inset-(inline|block)(-start|-end)?)$/;

/** Hex shortening outside url(...) and strings. */
function shortHex(v: string): string {
  let out = '';
  let i = 0;
  while (i < v.length) {
    const c = v[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < v.length && v[j] !== c) j += v[j] === '\\' ? 2 : 1;
      out += v.slice(i, j + 1);
      i = j + 1;
    } else if (v.startsWith('url(', i)) {
      const e = scan(v, i + 3, ')');
      out += v.slice(i, e + 1);
      i = e + 1;
    } else {
      let j = i;
      while (j < v.length && v[j] !== '"' && v[j] !== "'" && !v.startsWith('url(', j)) j++;
      out += v.slice(i, j).replace(SHORT_HEX, (_m, a, b, c2, d) => `#${a}${b}${c2}${d ?? ''}`);
      i = j;
    }
  }
  return out;
}

function zeroUnits(v: string): string {
  // Only at paren depth 0 (never inside calc()/clamp()/var()), only a bare token.
  let out = '';
  let depth = 0;
  for (const tok of v.split(/( |,|\(|\))/)) {
    if (tok === '(') depth++;
    else if (tok === ')') depth--;
    out += depth === 0 && /^0(px|em|rem|vh|vw)$/.test(tok) ? '0' : tok;
  }
  return out;
}

function tidyDecl(d: string): string {
  const c = d.indexOf(':');
  if (c < 0) return d;
  const prop = d.slice(0, c).trim().toLowerCase();
  let val = d.slice(c + 1);
  val = val.replace(/ !important$/i, '!important');
  val = shortHex(val);
  if (LENGTH_PROP.test(prop) && !/[(]/.test(val.replace(/\bvar\([^)]*\)/g, ''))) val = zeroUnits(val);
  return `${d.slice(0, c)}:${val}`;
}

/** " > " style combinators in a selector, outside strings/brackets and (for :nth-*) an+b arguments. */
function tidySelector(sel: string): string {
  let out = '';
  const stack: boolean[] = []; // true = parens where combinator spaces are safe to drop
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < sel.length && sel[j] !== c) j += sel[j] === '\\' ? 2 : 1;
      out += sel.slice(i, j + 1);
      i = j;
    } else if (c === '[') {
      const j = scan(sel, i + 1, ']');
      out += sel.slice(i, j + 1);
      i = j;
    } else if (c === '(') {
      const m = /:([a-z-]+)$/i.exec(out);
      stack.push(!!m && /^(is|not|where|has)$/i.test(m[1]));
      out += c;
    } else if (c === ')') {
      stack.pop();
      out += c;
    } else if (c === ' ' && (stack.length === 0 || stack[stack.length - 1]) && '>+~'.includes(sel[i + 1] ?? '') && sel[i + 2] === ' ') {
      out += sel[i + 1];
      i += 2;
    } else out += c;
  }
  return out;
}

function tidyNodes(nodes: Node[]): void {
  for (const n of nodes) {
    if (n.k === 'rule') {
      n.sel = tidySelector(n.sel);
      n.decls = n.decls.map(tidyDecl);
    } else if (n.k === 'group') tidyNodes(n.kids);
  }
}

export function optimizeCss(css: string): string {
  const nodes = parseNodes(css);
  tidyNodes(nodes);
  return emit(mergeNodes(nodes));
}
