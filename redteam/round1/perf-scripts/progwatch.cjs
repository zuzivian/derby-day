// Watch for shader programs compiled mid-match (after prepare()). node progwatch.cjs <seconds>
const { launch, openPage, helpers } = require('./common.cjs');
(async () => {
  const secs = Number(process.argv[2] || 60);
  const browser = await launch();
  const { page } = await openPage(browser, { renderer: '3d&debug3d', prefs: { halfSeconds: 600 } });
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derby3d, null, { timeout: 60000 });
  await page.evaluate(() => {
    const R = window.__derby3d;
    window.__progLog = [];
    let n = R.gl.info.programs.length;
    window.__progLog.push({ at: 'mount', n, t: performance.now() });
    const f = () => {
      const p = R.gl.info.programs;
      if (p.length !== n) {
        const s = window.__derbyMatch;
        for (const pr of p.slice(n)) window.__progLog.push({ tick: s.tick, phase: s.phase, restart: s.restart && s.restart.kind, ownerIsMe: s.ball.owner === s.controlled[0], name: pr.name, key: pr.cacheKey.split(',').slice(0, 3).join(',') + '...' + pr.cacheKey.split(',').slice(-4).join(','), cards: s.cards.length, n: p.length, t: Math.round(performance.now()) });
        n = p.length;
      }
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  const box = await page.locator('#pitch').boundingBox();
  const end = Date.now() + secs * 1000;
  let k = 0;
  while (Date.now() < end) {
    k++;
    const x = box.x + box.width * (0.15 + 0.7 * Math.random());
    const y = box.y + box.height * (0.2 + 0.65 * Math.random());
    await page.mouse.move(x, y, { steps: 3 });
    if (k % 4 === 0) await page.mouse.click(x, y, { delay: 80 });
    if (k % 9 === 0) { await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up(); }
    if (k % 13 === 0) await page.mouse.click(x, y, { button: 'right', delay: 300 });
    await page.waitForTimeout(250);
  }
  const log = await page.evaluate(() => ({ log: window.__progLog, tick: window.__derbyMatch.tick, total: window.__derby3d.gl.info.programs.length }));
  console.log(JSON.stringify(log, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
