// Live match: background tab for 5 s (rAF held, timers run, visibilitychange). Pause? Catch-up? Desync? Audio?
const { launch, openPage, helpers } = require('./common.cjs');
(async () => {
  const [renderer = '3d'] = process.argv.slice(2);
  const browser = await launch();
  const { page } = await openPage(browser, { renderer, prefs: { halfSeconds: 600 } });
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
  const box = await page.locator('#pitch').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 60 }); // a gesture, so audio starts
  await page.waitForTimeout(2000);
  const st = () => page.evaluate(() => ({ tick: window.__derbyMatch.tick, clock: document.querySelector('#sb-clock').textContent, paused: !document.querySelector('#pause').hidden, ac: window.__ac.map((a) => a.state).join(','), focus: document.activeElement && document.activeElement.id }));
  const a = await st();
  await page.evaluate(() => window.__hide(5000));
  const b = await st();
  await page.waitForTimeout(1500);
  const c = await st();
  await page.locator('#resume').click();
  const t0 = Date.now();
  await page.waitForTimeout(1000);
  const d = await st();
  console.log(JSON.stringify({ before: a, rightAfterShow: b, after1500ms: c, resumed1s: d, ticksPerSecAfterResume: +((d.tick - c.tick) / ((Date.now() - t0) / 1000)).toFixed(1) }, null, 1));
  await page.screenshot({ path: `/tmp/rt/perf/out/hide-${renderer}-paused.png` });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
