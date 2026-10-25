const { launch, ctx, URL, logErrors, shot } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  // 1) Back button mid first match, then forward
  {
    const c = await ctx(browser, {});
    const page = await c.newPage();
    logErrors(page, 'back');
    await page.goto('about:blank');
    await page.goto(URL);
    await page.locator('#ob-kickoff').click();
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.goBack();
    console.log('after back url', page.url());
    await page.goForward();
    await page.waitForTimeout(1500);
    const st = await page.evaluate(() => ({ welcome: !!document.querySelector('#ob-kickoff'), pitch: !!document.querySelector('#pitch'), paused: document.getElementById('pause') ? !document.getElementById('pause').hidden : null, tick: window.__derbyMatch?.tick }));
    console.log('after forward', JSON.stringify(st));
    await shot(page, 'edge_back_forward');
    await c.close();
  }
  // 2) "I've played before" -> level 1 home; then a warm-up loss
  {
    const c = await ctx(browser, {});
    const page = await c.newPage();
    await page.goto(URL);
    await page.locator('[data-action="skip-onboarding"]').click();
    await page.locator('#kick-off').waitFor();
    await page.waitForTimeout(300);
    await shot(page, 'edge_skip_home_l1');
    console.log('skip home L1', (await page.locator('#app').innerText()).replace(/\n+/g, ' | '));
    await c.close();
  }
  // 3) Visibility change mid first match: tip clock and pause
  {
    const c = await ctx(browser, {});
    const page = await c.newPage();
    await page.goto(URL);
    await page.locator('#ob-kickoff').click();
    await page.locator('.coach-tip:not([hidden])').waitFor({ timeout: 60000 });
    const a = await page.evaluate(() => window.__derbyCoach.state());
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(3000);
    const b = await page.evaluate(() => ({ coach: window.__derbyCoach.state(), paused: !document.getElementById('pause').hidden, tipVis: getComputedStyle(document.querySelector('.coach-tip')).visibility }));
    console.log('tab hidden', JSON.stringify({ ageBefore: a.age, after: b }));
    await shot(page, 'edge_tab_hidden');
    await c.close();
  }
  await browser.close();
})();
