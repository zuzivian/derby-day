#!/usr/bin/env node
// First paint and time-to-interactive of the built page in headless Chromium, with the CPU slowed down.
//
//   bun run build && NODE_PATH="$(npm root -g)" node scripts/perf-probe.cjs [runs=5] [cpuRate=4]
//
// Reports medians over `runs` cold loads (fresh context each time, web fonts blocked like a flaky network):
//   fcp    first-contentful-paint
//   ready  the first moment the club screen's tabs exist and can be clicked (our time-to-interactive)
//   tbt    total blocking time: sum of long-task time beyond 50 ms before `ready`
// Playwright is found the same way as in tests/e2e/run.cjs.

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function loadPlaywright() {
  for (const f of [() => require('playwright'), () => require('/opt/node22/lib/node_modules/playwright'), () => require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'))]) {
    try {
      return f();
    } catch {
      /* next */
    }
  }
  console.error('Could not find Playwright. npm i -g playwright@1 and set NODE_PATH="$(npm root -g)".');
  process.exit(2);
}

const runs = Number(process.argv[2] || 5);
const rate = Number(process.argv[3] || 4);
const url = pathToFileURL(path.resolve(__dirname, '..', 'dist', 'index.html')).href;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const out = { fcp: [], ready: [], tbt: [] };
  for (let i = 0; i < runs; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await page.addInitScript(() => {
      window.__perf = { ready: 0, long: [] };
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__perf.long.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true });
      const check = () => {
        if (!window.__perf.ready && document.querySelector('[data-action="nav"],[data-action="skip-onboarding"],button')) window.__perf.ready = performance.now();
      };
      new MutationObserver(check).observe(document, { childList: true, subtree: true });
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__perf.ready > 0 && performance.getEntriesByName('first-contentful-paint').length > 0);
    const m = await page.evaluate(() => {
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const ready = window.__perf.ready;
      const tbt = window.__perf.long.filter(([s]) => s < ready).reduce((n, [, d]) => n + Math.max(0, d - 50), 0);
      return { fcp: fcp ? fcp.startTime : 0, ready, tbt };
    });
    for (const k of Object.keys(out)) out[k].push(m[k]);
    await ctx.close();
  }
  await browser.close();
  const r = (a) => Math.round(median(a));
  console.log(`cold load, CPU x${rate}, ${runs} runs, medians: first paint ${r(out.fcp)} ms, interactive ${r(out.ready)} ms, blocking time ${r(out.tbt)} ms`);
  console.log(JSON.stringify({ runs, rate, fcp: out.fcp.map(Math.round), ready: out.ready.map(Math.round), tbt: out.tbt.map(Math.round) }));
})();
