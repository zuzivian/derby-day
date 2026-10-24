// High quality: does the drawing buffer follow a devicePixelRatio change mid-match? (2D too.)
const { launch, openPage, helpers } = require('./common.cjs');
(async () => {
  const [renderer = '3d&quality=high'] = process.argv.slice(2);
  const browser = await launch();
  const { page, cdp } = await openPage(browser, { renderer, prefs: { halfSeconds: 600 } });
  const c = cdp();
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 90000 });
  const st = () => page.evaluate(() => { const cv = document.querySelector('#pitch'); const r = cv.getBoundingClientRect(); const rd = document.querySelector('.hud-radar'); return { q: cv.dataset.quality, dpr: devicePixelRatio, cssW: Math.round(r.width), cw: cv.width, ch: cv.height, radarW: rd.width, radarCss: Math.round(rd.getBoundingClientRect().width) }; });
  await page.waitForTimeout(1500);
  console.log('dpr1', JSON.stringify(await st()));
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(3000);
  console.log('dpr2 same css size', JSON.stringify(await st()));
  await page.screenshot({ path: `/tmp/rt/perf/out/dpr2-${renderer.replace(/[^a-z0-9]/gi, '')}.png`, clip: { x: 300, y: 250, width: 300, height: 200 } });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 800, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(3000);
  console.log('dpr2 after a resize', JSON.stringify(await st()));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
