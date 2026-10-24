// Zero-dependency build: bundle with Bun, inline into one HTML file.
//   bun run build           -> dist/index.html (open directly) + dist/derby-day.artifact.html
//   bun run dev             -> rebuild on change and serve on http://localhost:5173

import { watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url).pathname;
const dist = `${root}dist`;

async function build(): Promise<void> {
  const t0 = performance.now();
  const out = await Bun.build({ entrypoints: [`${root}src/client/main.ts`], target: 'browser', minify: true, format: 'esm' });
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    throw new Error('Bundle failed');
  }
  const js = (await out.outputs[0].text()).replace(/<\/script/gi, '<\\/script');
  // styles.css plus per-feature sheets that sit beside it.
  const css = (await Promise.all(['styles.css', 'review.css', 'replay.css', 'levels.css', 'hud.css', 'coach.css', 'tactics.css'].map((f) => readFile(`${root}src/client/${f}`, 'utf8')))).join('\n');
  const fragment = (await readFile(`${root}src/client/page.html`, 'utf8'))
    .replace('/*__CSS__*/', () => css)
    .replace('/*__JS__*/', () => js);
  const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;
  await mkdir(dist, { recursive: true });
  await writeFile(`${dist}/index.html`, full);
  // The artifact host supplies its own document skeleton.
  await writeFile(`${dist}/derby-day.artifact.html`, fragment);
  console.log(`built in ${Math.round(performance.now() - t0)} ms, ${(full.length / 1024).toFixed(0)} KB`);
}

await build();

if (process.argv.includes('--watch')) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(`${root}src`, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error(e)), 80);
  });
  Bun.serve({ port: 5173, fetch: () => new Response(Bun.file(`${dist}/index.html`), { headers: { 'content-type': 'text/html' } }) });
  console.log('serving http://localhost:5173 (rebuilds on save; refresh the page)');
}
