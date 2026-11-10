#!/usr/bin/env node
// Close-up screenshots of the 3D match at the camera's nearest zoom, for judging the players in the
// real scene (kits, numbers, names, animation), at high quality and 2x pixels.
//   bun run build && node scripts/closeup-probe.cjs [outDir=probe/closeup]
// TOD=day|dusk|night sets the time of day, ZOOM the camera zoom (0.6 nearest .. 1.45), QUALITY low|high, POST=off no post-processing.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { openApp, startRanked } = require('../tests/e2e/lib/helpers.cjs');

const outDir = path.resolve(process.argv[2] || 'probe/closeup');
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const t = { newPage: async (opts) => (await browser.newContext({ ...opts, deviceScaleFactor: Number(process.env.DPR || 2) })).newPage() };
  const page = await openApp(t, { width: 1280, height: 800, prefs: { halfSeconds: 600 }, e2eHook: true, renderer: '3d', query: `quality=${process.env.QUALITY || 'high'}&governor=off${process.env.TOD ? `&tod=${process.env.TOD}` : ''}${process.env.POST === 'off' ? '&post=off' : ''}`, init: `localStorage.setItem('derby-zoom', '${Number(process.env.ZOOM || 0.6)}')` });
  await startRanked(page);
  for (let i = 0; i < 40 && !(await page.evaluate(() => window.__derbyMatch && window.__derbyMatch.phase === 'play')); i++) await page.waitForTimeout(250);
  for (const [n, wait] of [[1, 2500], [2, 2500], [3, 2500]]) {
    await page.waitForTimeout(wait);
    const f = path.join(outDir, `${process.env.TOD || 'auto'}-${process.env.ZOOM || 0.6}-${n}.png`);
    await page.screenshot({ path: f });
    console.log(f);
  }
  await browser.close();
})();
