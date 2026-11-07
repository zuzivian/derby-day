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

/** Bun.build plugin: applies minifyGlslStrings to the vendored three.module.js. */
export const glslMinPlugin: Bun.BunPlugin = {
  name: 'glsl-min',
  setup(build) {
    build.onLoad({ filter: /vendor[\\/]three[\\/]three\.module\.js$/ }, async (args) => ({
      contents: minifyGlslTemplates(minifyGlslStrings(await Bun.file(args.path).text())),
      loader: 'js',
    }));
  },
};
