// Build-time GLSL shrink for the vendored three.js. Its official build already dropped the comments from the
// shader chunks but kept the tab indentation as "\n\t\t..." inside one-line string constants. GLSL treats
// leading whitespace as nothing (and three's #include matcher allows none), so the indentation goes.
// Only top-level `const|var|let name = "..."` strings that look like GLSL are rewritten; the vendor file on
// disk stays unchanged.

const GLSL_HINT = /#include|#define|#if|\bvoid\s+main\b|\buniform\s|\bvarying\s|\bprecision\s|\bgl_[A-Z]/;

/** Remove indentation after each escaped newline in every GLSL string constant of `src`. */
export function minifyGlslStrings(src: string): string {
  return src.replace(/^((?:const|var|let) [\w$]+ = )("(?:[^"\\\n]|\\.)*")(;)$/gm, (all, pre: string, lit: string, end: string) => {
    if (!GLSL_HINT.test(lit)) return all;
    return pre + lit.replace(/\\n(?:\\t| )+/g, '\\n').replace(/^"(?:\\t| )+/, '"') + end;
  });
}

/**
 * three's own `/* glsl *\/` templates (PMREM, program prefixes, ...): drop indentation and blank lines. Only templates
 * with no `${}` and no `//` or block comment, so there is nothing to misread; anything else is left as it is.
 */
export function minifyGlslTemplates(src: string): string {
  return src.replace(/(\/\* glsl \*\/\s*)(`[^`$\\]*`)/g, (all, pre: string, lit: string) => {
    if (/\/\/|\/\*/.test(lit)) return all;
    const lines = lit.slice(1, -1).split('\n').map((l) => l.trim()).filter((l, i, a) => l !== '' || i === 0 || i === a.length - 1);
    return pre + '`' + lines.join('\n') + '`';
  });
}

const MULTI_OPS = new Set(['==', '!=', '<=', '>=', '&&', '||', '^^', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '//', '/*', '*/']);

/** Collapse the whitespace between the tokens of one line of GLSL code, keeping a space only where two tokens would otherwise fuse. */
function squeezeGlslLine(line: string): string {
  const tokens = line.trim().split(/\s+/);
  let out = tokens[0];
  for (let i = 1; i < tokens.length; i++) {
    const a = out[out.length - 1];
    const b = tokens[i][0];
    const word = /\w/.test(a) && /\w/.test(b);
    const dot = a === '.' || b === '.';
    out += word || dot || MULTI_OPS.has(a + b) ? ' ' + tokens[i] : tokens[i];
  }
  return out;
}

/**
 * Second GLSL pass for the chunks minifyGlslStrings already de-indented: inside plain code lines, drop the spaces
 * between tokens that cannot fuse ("vec3( a, b )" becomes "vec3(a,b)"). The result is the same token stream,
 * so the shader compiles to the same program. Preprocessor lines (#...) are left exactly as they are (a macro's
 * name must stay apart from its "(" and three matches on these lines), as is any string holding a comment or a
 * line continuation, and any literal that is not plain JSON-style.
 */
export function squeezeGlslStrings(src: string): string {
  return src.replace(/^((?:const|var|let) [\w$]+ = )("(?:[^"\\\n]|\\.)*")(;)$/gm, (all, pre: string, lit: string, end: string) => {
    if (!GLSL_HINT.test(lit)) return all;
    let text: string;
    try {
      text = JSON.parse(lit) as string;
    } catch {
      return all;
    }
    if (/\/[/*]|\\\n/.test(text)) return all;
    const out = text.split('\n').map((l) => (l.trimStart().startsWith('#') || l.trim() === '' ? l : squeezeGlslLine(l)));
    return pre + JSON.stringify(out.join('\n')) + end;
  });
}

/** Bun.build plugin: applies the GLSL shrinkers to the vendored three.module.js. */
export const glslMinPlugin: Bun.BunPlugin = {
  name: 'glsl-min',
  setup(build) {
    build.onLoad({ filter: /vendor[\\/]three[\\/]three\.module\.js$/ }, async (args) => ({
      contents: minifyGlslTemplates(squeezeGlslStrings(minifyGlslStrings(await Bun.file(args.path).text()))),
      loader: 'js',
    }));
  },
};
