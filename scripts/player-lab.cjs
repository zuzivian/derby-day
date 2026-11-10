#!/usr/bin/env node
// Screenshots of the player lab (dist/lab.html, built by scripts/lab.ts) at fixed clock times, in each camera.
//   bun run scripts/lab.ts && node scripts/player-lab.cjs [outDir=probe/lab] [t=0.45,0.9] [cams=close,side,broadcast]

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const outDir = path.resolve(process.argv[2] || 'probe/lab');
const times = (process.argv[3] || '0.45,0.9').split(',').map(Number);
const cams = (process.argv[4] || 'close,side,broadcast').split(',');
const file = path.resolve(__dirname, '../dist/lab.html');
const pick = process.env.PICK ? `&pick=${process.env.PICK}` : '';
const tag = process.env.TAG ? `${process.env.TAG}-` : '';

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const cam of cams) {
    for (const t of times) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 700 }, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => console.error('page error:', e.message));
      await page.goto(`file://${file}?cam=${cam}&t=${t}${pick}`);
      await page.waitForFunction(() => window.__lab && window.__lab.ready);
      const f = path.join(outDir, `${tag}${cam}-${t}.png`);
      await page.screenshot({ path: f });
      console.log(f);
      await page.close();
    }
  }
  await browser.close();
})();
