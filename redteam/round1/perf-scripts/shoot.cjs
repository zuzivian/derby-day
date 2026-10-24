// Cup shootout: what happens if the tab is hidden while the keeper read is open, or while a kick charges?
const { launch, openPage, helpers } = require('./common.cjs');
(async () => {
  const browser = await launch();
  let page;
  for (let attempt = 0; attempt < 5; attempt++) {
    ({ page } = await openPage(browser, { renderer: '2d', prefs: { halfSeconds: 1 } }));
    await helpers.goTab(page, 'competitions');
    await page.locator('[data-action="comp-start-cup"]').click();
    await page.locator('[data-action="comp-play"][data-kind="cup"]').click();
    await page.locator('.shootout, .modal').first().waitFor({ timeout: 60000 });
    if (await page.locator('.shootout').count()) break;
    await page.close();
    page = null;
  }
  if (!page) throw new Error('no drawn match');
  await page.locator('#so-start').click();
  const phase = () => page.evaluate(() => document.querySelector('.shootout')?.dataset.phase);
  const live = () => page.evaluate(() => document.querySelector('#so-live')?.textContent || '');
  const results = [];
  for (let k = 0; k < 6; k++) {
    await page.waitForFunction(() => ['aim', 'telegraph', 'done'].includes(document.querySelector('.shootout')?.dataset.phase), null, { timeout: 30000 });
    const ph = await phase();
    if (ph === 'done') break;
    if (ph === 'telegraph') {
      const before = await live();
      const t0 = Date.now();
      await page.evaluate(() => window.__hide(5000)); // tab in the background for 5 s during the 3.8 s keeper read
      await page.waitForTimeout(700);
      results.push({ role: 'keeper', hiddenMs: Date.now() - t0, before: before.slice(0, 80), after: (await live()).slice(0, 120), phase: await phase() });
      await page.waitForFunction(() => !['telegraph'].includes(document.querySelector('.shootout')?.dataset.phase), null, { timeout: 30000 });
    } else {
      // Taker: start charging with the mouse held, then the tab goes to the background for 3 s.
      const box = await page.locator('#so-canvas').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.35);
      await page.mouse.down();
      await page.waitForTimeout(150);
      const ph2 = await phase();
      await page.evaluate(() => window.__hide(3000));
      await page.waitForTimeout(700);
      await page.mouse.up();
      results.push({ role: 'taker', chargingBeforeHide: ph2, after: (await live()).slice(0, 140), phase: await phase() });
    }
    await page.waitForFunction(() => ['aim', 'telegraph', 'done', 'result'].includes(document.querySelector('.shootout')?.dataset.phase), null, { timeout: 30000 });
    await page.waitForTimeout(2200);
    if (results.length >= 3) break;
  }
  console.log(JSON.stringify(results, null, 1));
  await page.screenshot({ path: '/tmp/rt/perf/out/shootout-after-hide.png' });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
