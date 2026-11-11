// Build-time whitespace trim for HTML template strings in src/client.
//
// A run of whitespace that contains a newline and sits between a tag's closing '>' and the next tag's '<' is
// replaced by ONE space. In every normal white-space context that renders exactly like the original run (runs
// collapse to a single space), and a whitespace-only text node stays a text node, so :empty and sibling
// selectors behave the same. Nothing is touched inside <textarea>, <pre>, <script>, <style> or comments, inside
// a tag's attributes, next to a ${...} substitution, in tagged templates, or in templates that are not HTML.
// Sources keep their layout; only the bundled copy is smaller.

export interface TrimResult {
  out: string;
  /** Source offsets [start, end) of each whitespace run that was replaced. */
  edits: Array<[number, number]>;
}

const RAW = /^(textarea|pre|script|style|title|xmp|plaintext)$/i;
const KEYWORDS = new Set(['return', 'typeof', 'case', 'yield', 'await', 'in', 'of', 'else', 'do', 'void', 'delete', 'throw', 'new', 'instanceof']);
const isIdent = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

interface Quasi {
  start: number; // source offset of the segment's first character
  end: number;
}

/** Finds the whitespace runs to collapse in one template literal, given its text segments (substitutions sit between them). */
function runsFor(src: string, segs: Quasi[]): Array<[number, number]> {
  // Join the segments with a sentinel for each ${...}; remember where each segment starts in the joined text.
  const SENT = '\u0000';
  let joined = '';
  const map: Array<{ j: number; s: number }> = [];
  segs.forEach((q, i) => {
    if (i) joined += SENT;
    map.push({ j: joined.length, s: q.start });
    joined += src.slice(q.start, q.end);
  });
  if (!/<[A-Za-z]/.test(joined)) return [];
  // Anything that could change how whitespace renders or is read back: leave the whole template alone.
  if (/<(pre|textarea|script|style|xmp|plaintext|listing)\b/i.test(joined) || /white-space/i.test(joined)) return [];
  const toSrc = (j: number): number => {
    let k = map.length - 1;
    while (map[k].j > j) k--;
    return map[k].s + (j - map[k].j);
  };
  const runs: Array<[number, number]> = [];
  let i = 0;
  const n = joined.length;
  while (i < n) {
    const c = joined[i];
    if (c !== '<') {
      i++;
      continue;
    }
    if (joined.startsWith('<!--', i)) {
      const e = joined.indexOf('-->', i + 4);
      if (e < 0) return runs;
      i = e + 3;
      continue;
    }
    if (!/[A-Za-z/!?]/.test(joined[i + 1] ?? '')) {
      i++;
      continue;
    }
    // Inside a tag: skip to its closing '>' honouring quoted attribute values.
    const nameMatch = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(joined.slice(i, i + 40));
    let j = i + 1;
    let q = '';
    while (j < n) {
      const d = joined[j];
      if (q) {
        if (d === q) q = '';
      } else if (d === '"' || d === "'") q = d;
      else if (d === '>') break;
      else if (d === '<' && !q) return runs; // malformed or substitution-built markup: stop trusting this template
      j++;
    }
    if (j >= n || q) return runs;
    if (nameMatch && !joined.startsWith('</', i) && RAW.test(nameMatch[1])) return runs;
    // joined[j] is the tag's '>'. Look at the whitespace after it.
    let k = j + 1;
    while (k < n && (joined[k] === ' ' || joined[k] === '\t' || joined[k] === '\n' || joined[k] === '\r')) k++;
    if (k > j + 1 && joined[k] === '<' && /[A-Za-z/]/.test(joined[k + 1] ?? '') && /\n/.test(joined.slice(j + 1, k))) {
      // A single space is no shorter than a lone space already there, so only runs longer than 1 shrink.
      if (k - (j + 1) > 1 || joined[j + 1] !== ' ') runs.push([toSrc(j + 1), toSrc(j + 1) + (k - (j + 1))]);
    }
    i = j + 1;
  }
  return runs;
}

/** Returns `src` with the safe whitespace runs inside untagged HTML template literals collapsed. */
export function trimTemplateWhitespace(src: string): TrimResult {
  const edits: Array<[number, number]> = [];
  const n = src.length;
  let i = 0;
  let prev = ''; // last significant (non-space, non-comment) source char
  let prevWord = ''; // identifier ending at prev, if any

  const lastWord = (end: number): string => {
    let s = end;
    while (s > 0 && isIdent(src[s - 1])) s--;
    return src.slice(s, end);
  };

  /** Scans code until `stop` ('}' closing a substitution, or end of file when null). */
  function code(stopAtBrace: boolean): void {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
      } else if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
      } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++;
      } else if (c === '"' || c === "'") {
        i++;
        while (i < n && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
        i++;
        prev = c;
        prevWord = '';
      } else if (c === '`') {
        // Tagged when an identifier or ) or ] directly precedes it (a keyword like return does not count).
        const tagged = (isIdent(prev) && !KEYWORDS.has(prevWord)) || prev === ')' || prev === ']';
        template(tagged);
        prev = '`';
        prevWord = '';
      } else if (c === '/') {
        const divides = isIdent(prev) ? !KEYWORDS.has(prevWord) : prev === ')' || prev === ']' || prev === '}' || prev === '"' || prev === "'" || prev === '`';
        if (divides) {
          i++;
          prev = '/';
          prevWord = '';
        } else {
          i++;
          let cls = false;
          while (i < n && (cls || src[i] !== '/') && src[i] !== '\n') {
            if (src[i] === '\\') i++;
            else if (src[i] === '[') cls = true;
            else if (src[i] === ']') cls = false;
            i++;
          }
          i++;
          while (i < n && isIdent(src[i])) i++;
          prev = ')';
          prevWord = '';
        }
      } else if (c === '{') {
        depth++;
        i++;
        prev = c;
        prevWord = '';
      } else if (c === '}') {
        if (stopAtBrace && depth === 0) return;
        depth--;
        i++;
        prev = c;
        prevWord = '';
      } else {
        i++;
        prev = c;
        prevWord = isIdent(c) ? lastWord(i) : '';
      }
    }
  }

  function template(tagged: boolean): void {
    i++; // opening backtick
    const segs: Quasi[] = [];
    let start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        segs.push({ start, end: i });
        i++;
        break;
      } else if (c === '$' && src[i + 1] === '{') {
        segs.push({ start, end: i });
        i += 2;
        const savedPrev = prev;
        prev = '{';
        code(true);
        prev = savedPrev;
        i++; // the closing }
        start = i;
      } else i++;
    }
    if (!tagged) for (const r of runsFor(src, segs)) edits.push(r);
  }

  code(false);
  edits.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [s, e] of edits) {
    out += src.slice(at, s) + ' ';
    at = e;
  }
  out += src.slice(at);
  return { out, edits };
}

/** Bun.build plugin: trims the template whitespace of the client sources (not the 3D code, not the sim). */
export const htmlTrimPlugin: import('bun').BunPlugin = {
  name: 'html-trim',
  setup(build) {
    build.onLoad({ filter: /src[\\/]client[\\/](?!r3d[\\/])[^\\/]+\.ts$/ }, async (args) => ({
      contents: trimTemplateWhitespace(await Bun.file(args.path).text()).out,
      loader: 'ts',
    }));
  },
};
