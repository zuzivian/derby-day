// Independent leak check: N short ranked matches, back to Home after each, forced GC, then metrics + instance counts.
const { chromium } = require('playwright');
const H = require('/tmp/rt/perf-verify/repo/tests/e2e/lib/helpers.cjs');
const renderer = process.argv[2] || '3d';
const N = Number(process.argv[3] || 4);
const half = Number(process.argv[4] || 3);
const e2e = process.env.E2E === '1';
const fix = process.env.FIX === '1';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const t = { newPage: async (o) => { const c = await browser.newContext(o); const p = await c.newPage(); await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); return p; } };
  const page = await H.openApp(t, { prefs: { halfSeconds: half }, renderer, e2eHook: e2e });
  if (process.env.INIT) await page.addInitScript(process.env.INIT), await page.reload(), await page.locator('#app *').first().waitFor();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  async function count(protoExpr, filterFn) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: protoExpr });
    if (!result.objectId) return -1;
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: result.objectId });
    const r = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: filterFn || 'function(){return this.length}', returnByValue: true });
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: '' }).catch(() => {});
    return r.result.value;
  }
  async function measure(label) {
    await page.waitForTimeout(800);
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const canvases = await count('HTMLCanvasElement.prototype');
    const pitchDetached = await count('HTMLCanvasElement.prototype', 'function(){return this.filter(c=>c.id==="pitch"&&!c.isConnected).length}');
    const gl2 = await count('WebGL2RenderingContext.prototype');
    const ro = await count('ResizeObserver.prototype');
    console.log(`${label.padEnd(12)} heap ${(m.JSHeapUsedSize / 1e6).toFixed(2)} MB  nodes ${m.Nodes}  listeners ${m.JSEventListeners}  canvases ${canvases}  detached#pitch ${pitchDetached}  webgl2ctx ${gl2}  ResizeObservers ${ro}`);
  }
  await measure('home-0');
  for (let i = 1; i <= N; i++) {
    await H.goTab(page, H.SEL.homeScreen); await page.locator(H.SEL.playRanked).click(); await page.locator(H.SEL.pitch).waitFor();
    const rend = await page.locator('#pitch').getAttribute('data-renderer');
    await page.locator(H.SEL.modal).waitFor({ timeout: 120000 });
    if (fix) await page.evaluate(() => window.__fixSingletons && window.__fixSingletons());
    await page.locator(H.SEL.modalClose).click();
    await page.locator(H.SEL.modal).waitFor({ state: 'detached' });
    await measure(`home-${i} (${rend})`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
