// Tab hidden/visible, window resize and devicePixelRatio 3 mid-match. node vis.cjs <renderer> <tag>
const fs = require('fs');
const { launch, openPage, helpers } = require('./common.cjs');
const OUT = '/tmp/rt/perf/out';
(async () => {
  const [renderer = '3d', tag = 'vis', quality = ''] = process.argv.slice(2);
  const browser = await launch();
  const { page, cdp, problems, logs } = await openPage(browser, { renderer: renderer + (quality ? `&quality=${quality}` : ''), prefs: { halfSeconds: 600 } });
  const c = cdp();
  const log = (...a) => console.log(...a);
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
  const st = () => page.evaluate(() => {
    const s = window.__derbyMatch; const cv = document.querySelector('#pitch'); const r = cv.getBoundingClientRect();
    return { ac: (window.__ac || []).map((a) => a.state).join(','), tick: s.tick, phase: s.phase, paused: !document.querySelector('#pause').hidden, hidden: document.hidden, vis: document.visibilityState, cw: cv.width, ch: cv.height, cssW: Math.round(r.width), cssH: Math.round(r.height), dpr: devicePixelRatio, fps: cv.dataset.fps, scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
  });
  await page.waitForTimeout(3000);
  log('before', JSON.stringify(await st()));
  // --- A: real hide via window minimise (CDP Browser domain)
  const { windowId } = await c.send('Browser.getWindowForTarget');
  const a0 = await st();
  await c.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await page.waitForTimeout(400);
  const a1 = await page.evaluate(() => ({ hidden: document.hidden, vis: document.visibilityState, tick: window.__derbyMatch.tick }));
  await page.waitForTimeout(4000);
  const a2 = await page.evaluate(() => ({ hidden: document.hidden, tick: window.__derbyMatch.tick }));
  await c.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await page.waitForTimeout(800);
  const a3 = await st();
  log('minimise', JSON.stringify({ a0, a1, a2, a3 }));
  // Resume if paused.
  if (a3.paused) { await page.locator('#resume').click(); await page.waitForTimeout(1500); }
  // --- B: synthetic visibilitychange (document.hidden overridden), for headless builds that don't hide on minimise.
  const b0 = await st();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(1500);
  const b1 = await st();
  await page.evaluate(() => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(1500);
  const b2 = await st();
  log('synthetic', JSON.stringify({ b0, b1, b2 }));
  if (b2.paused) { await page.locator('#resume').click(); await page.waitForTimeout(1000); }
  // --- C: resize mid-match
  const sizes = [[390, 844], [1920, 1080], [844, 390], [1280, 800]];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(2500);
    const r = await st();
    // World point under the canvas centre, through the renderer (mouse picking stays consistent?)
    log('resize', w, h, JSON.stringify(r));
    await page.screenshot({ path: `${OUT}/${tag}-resize-${w}x${h}.png` });
  }
  // --- D: DPR 3 mid-match (same CSS size)
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 3, mobile: false });
  await page.waitForTimeout(3000);
  const d1 = await st();
  log('dpr3', JSON.stringify(d1));
  await page.screenshot({ path: `${OUT}/${tag}-dpr3.png` });
  // Back to DPR 1, and then a phone at DPR 3.
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await page.waitForTimeout(3000);
  const d2 = await st();
  log('phone-dpr3', JSON.stringify(d2));
  await page.screenshot({ path: `${OUT}/${tag}-phone-dpr3.png` });
  await c.send('Emulation.clearDeviceMetricsOverride');
  await page.waitForTimeout(1500);
  log('cleared', JSON.stringify(await st()));
  // --- E: WebGL context lost and restored mid-match (mobile GPUs and driver resets do this).
  if (renderer.startsWith('3d')) {
    const e0 = await st();
    const lost = await page.evaluate(() => {
      const live = window.__gl.filter((g) => !g.isContextLost());
      const gl = live[live.length - 1];
      if (!gl) return 'no live context';
      window.__loseExt = gl.getExtension('WEBGL_lose_context');
      window.__loseExt.loseContext();
      return 'lost';
    });
    await page.waitForTimeout(1500);
    const e1 = await st();
    await page.screenshot({ path: `${OUT}/${tag}-ctx-lost.png` });
    await page.evaluate(() => window.__loseExt.restoreContext());
    await page.waitForTimeout(4000);
    const e2 = await st();
    await page.screenshot({ path: `${OUT}/${tag}-ctx-restored.png` });
    log('ctxloss', lost, JSON.stringify({ e0, e1, e2 }));
  }
  fs.writeFileSync(`${OUT}/${tag}.json`, JSON.stringify({ problems, logs }, null, 1));
  log('problems', JSON.stringify(problems), 'logs', JSON.stringify(logs.slice(0, 30)));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
