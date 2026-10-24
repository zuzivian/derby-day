// Many short 3D matches in one tab: watch console for WebGL context warnings, check the last match still renders 3D.
const { chromium } = require('playwright');
const H = require('/tmp/rt/perf-verify/repo/tests/e2e/lib/helpers.cjs');
const N = Number(process.argv[2] || 18);
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const t = { newPage: async (o) => { const c = await browser.newContext(o); const p = await c.newPage(); await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); return p; } };
  const page = await H.openApp(t, { prefs: { halfSeconds: 2 }, renderer: '3d' });
  const msgs = [];
  page.on('console', (m) => { const s = m.text(); if (/webgl|context/i.test(s)) msgs.push(s); });
  page.on('pageerror', (e) => msgs.push('PAGEERROR ' + e.message));
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  for (let i = 1; i <= N; i++) {
    await H.goTab(page, H.SEL.homeScreen); await page.locator(H.SEL.playRanked).click(); await page.locator(H.SEL.pitch).waitFor();
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => { const c = document.querySelector('#pitch'); return { r: c.dataset.renderer, fps: c.dataset.fps, calls: c.dataset.calls }; });
    if (i === 1 || i === N) await page.screenshot({ path: `/tmp/rt/perf-verify/out/many-match${i}.png` });
    await page.locator(H.SEL.modal).waitFor({ timeout: 300000 });
    await page.locator(H.SEL.modalClose).click();
    await page.locator(H.SEL.modal).waitFor({ state: 'detached' });
    for (let k = 0; k < 2; k++) await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    console.log(`match ${i}: renderer=${info.r} calls=${info.calls} | home heap ${(m.JSHeapUsedSize / 1e6).toFixed(1)} MB nodes ${m.Nodes} listeners ${m.JSEventListeners} | console msgs so far ${msgs.length}`);
  }
  console.log('console messages:', [...new Set(msgs)].slice(0, 10));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
