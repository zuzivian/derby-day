// Zero-dependency build: bundle with Bun, inline into one HTML file.
//   bun run build           -> dist/index.html (open directly) + dist/derby-day.artifact.html,
//                              plus static/ (icons, manifest, robots.txt, 404, share image) and dist/sw.js
//   bun run dev             -> rebuild on change and serve on http://localhost:5173
//
// Build-time environment (all optional; empty = off, see docs/OPS.md):
//   DERBY_ERROR_URL       where crash reports are sent (errors.ts)
//   DERBY_TELEMETRY_URL   where anonymous usage counts are sent (telemetry.ts)
//   DERBY_BUILD_ID        build id for crash details and the offline cache (default: Vercel's commit, else git's, else a timestamp)

import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url).pathname;
const dist = `${root}dist`;

const SITE = 'https://derby.natwong.dev/';
const TITLE = 'Derby Day: run a football club and play every match yourself';
const DESCRIPTION = 'Run a football club and play its matches yourself, mouse-first, in the browser. Free, no sign-up.';

function buildId(): string {
  if (process.env.DERBY_BUILD_ID) return process.env.DERBY_BUILD_ID;
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  const git = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: root });
  const sha = git.exitCode === 0 ? git.stdout.toString().trim() : '';
  return sha || `t${Date.now().toString(36)}`;
}

const sha256 = (text: string): string => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

/** Origins crash reports and telemetry may be sent to (connect-src). A relative URL is the page's own origin. */
function connectOrigins(): string {
  const out = new Set<string>();
  for (const v of [process.env.DERBY_ERROR_URL, process.env.DERBY_TELEMETRY_URL]) {
    if (!v) continue;
    try {
      if (/^https?:\/\//i.test(v)) out.add(new URL(v).origin);
    } catch {
      /* not a URL: nothing to allow */
    }
  }
  return [...out].join(' ');
}

/**
 * Content-Security-Policy for the standalone page (a <meta>, so it travels with the file; the artifact
 * fragment has none because its host sets its own). The one inline script is allowed by its hash, so
 * injected script cannot run. Styles allow 'unsafe-inline' because fx.ts and versus.ts add <style> elements
 * at run time and the templates use style="" attributes; style injection is a far smaller risk than script.
 * frame-ancestors cannot be set from a <meta>: vercel.json sends it as a header.
 */
function csp(js: string): string {
  return [
    `default-src 'self'`,
    `script-src ${sha256(js)}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src https://fonts.gstatic.com`,
    `img-src 'self' data: blob:`,
    `media-src 'self' data: blob:`,
    `connect-src 'self' ${connectOrigins()}`.trim(),
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

/** Extra <head> for the standalone page: install, share and search metadata. Not in the artifact fragment. */
function headMeta(js: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return [
    `<meta http-equiv="Content-Security-Policy" content="${esc(csp(js))}">`,
    `<title>Derby Day</title>`,
    `<meta name="description" content="${esc(DESCRIPTION)}">`,
    `<link rel="canonical" href="${SITE}">`,
    `<meta name="theme-color" content="#e9eeec" media="(prefers-color-scheme: light)">`,
    `<meta name="theme-color" content="#18211f" media="(prefers-color-scheme: dark)">`,
    `<link rel="manifest" href="/manifest.webmanifest">`,
    `<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">`,
    `<link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192">`,
    `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-title" content="Derby Day">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Derby Day">`,
    `<meta property="og:title" content="${esc(TITLE)}">`,
    `<meta property="og:description" content="${esc(DESCRIPTION)}">`,
    `<meta property="og:url" content="${SITE}">`,
    `<meta property="og:image" content="${SITE}og.png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="Derby Day: a football pitch, the club crest and the line Run a football club, play every match yourself.">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(TITLE)}">`,
    `<meta name="twitter:description" content="${esc(DESCRIPTION)}">`,
    `<meta name="twitter:image" content="${SITE}og.png">`,
  ].join('\n');
}

async function build(): Promise<void> {
  const t0 = performance.now();
  const id = buildId();
  const out = await Bun.build({
    entrypoints: [`${root}src/client/boot.ts`],
    target: 'browser',
    minify: true,
    format: 'esm',
    define: {
      __BUILD_ID__: JSON.stringify(id),
      __ERROR_URL__: JSON.stringify(process.env.DERBY_ERROR_URL ?? ''),
      __TELEMETRY_URL__: JSON.stringify(process.env.DERBY_TELEMETRY_URL ?? ''),
    },
  });
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    throw new Error('Bundle failed');
  }
  const js = (await out.outputs[0].text()).replace(/<\/script/gi, '<\\/script');
  // styles.css plus per-feature sheets that sit beside it.
  const css = (await Promise.all(['styles.css', 'review.css', 'replay.css', 'levels.css', 'hud.css', 'platform.css'].map((f) => readFile(`${root}src/client/${f}`, 'utf8')))).join('\n');
  const fragment = (await readFile(`${root}src/client/page.html`, 'utf8'))
    .replace('/*__CSS__*/', () => css)
    .replace('/*__JS__*/', () => js);
  // The title and description live in <head> on the standalone page; the artifact keeps them in its fragment.
  const bodyFragment = fragment
    .replace(/<title>[^<]*<\/title>\n?/, '')
    .replace(/<meta name="description"[^>]*>\n?/, '')
    .replace(/<meta name="claude:viewport-fit-sides"[^>]*>\n?/, '');
  const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${headMeta(js)}\n</head>\n<body>\n${bodyFragment}\n</body>\n</html>\n`;
  await mkdir(dist, { recursive: true });
  await writeFile(`${dist}/index.html`, full);
  // The artifact host supplies its own document skeleton.
  await writeFile(`${dist}/derby-day.artifact.html`, fragment);
  // Static files (icons, manifest, robots.txt, 404, share image) are copied as they are; the service
  // worker gets this build's id so each deploy has its own offline cache.
  await cp(`${root}static`, dist, { recursive: true });
  await writeFile(`${dist}/sw.js`, (await readFile(`${root}static/sw.js`, 'utf8')).replace('__BUILD_ID__', id));
  console.log(`built in ${Math.round(performance.now() - t0)} ms, ${(full.length / 1024).toFixed(0)} KB, build ${id}`);
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
