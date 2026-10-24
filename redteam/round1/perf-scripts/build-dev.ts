// Unminified build of the scratch worktree for allocation profiling (same layout as scripts/build.ts).
import { readFile, writeFile } from 'node:fs/promises';
const root = '/tmp/rt/perf/repo/';
const out = await Bun.build({ entrypoints: [`${root}src/client/main.ts`], target: 'browser', minify: false, format: 'esm' });
if (!out.success) { console.error(out.logs); process.exit(1); }
const js = (await out.outputs[0].text()).replace(/<\/script/gi, '<\\/script');
const css = (await Promise.all(['styles.css', 'review.css', 'replay.css', 'levels.css', 'hud.css', 'coach.css'].map((f) => readFile(`${root}src/client/${f}`, 'utf8')))).join('\n');
const fragment = (await readFile(`${root}src/client/page.html`, 'utf8')).replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;
await writeFile('/tmp/rt/perf/out/dev/index.html', full);
await writeFile('/tmp/rt/perf/out/dev/bundle.js', js);
console.log('dev build', full.length);
