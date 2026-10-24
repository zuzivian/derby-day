const { launch, openPage, helpers } = require('./common.cjs');
(async () => {
  const browser = await launch();
  for (const [w, h] of [[1280, 800], [390, 844]]) {
    const { page } = await openPage(browser, { renderer: '2d', prefs: { halfSeconds: 600 }, width: w, height: h });
    await helpers.startRanked(page);
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `/tmp/rt/perf/out/2d-${w}x${h}.png` });
    console.log(w, h, JSON.stringify(await page.evaluate(() => { const c = document.querySelector('#pitch'); const r = c.getBoundingClientRect(); return { cw: c.width, ch: c.height, css: [Math.round(r.width), Math.round(r.height)], scrollW: document.documentElement.scrollWidth }; })));
    await page.context().close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
