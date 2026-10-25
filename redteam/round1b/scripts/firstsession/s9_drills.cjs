const { launch, ctx, URL, shot } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  const c = await ctx(browser, {});
  const page = await c.newPage();
  await page.goto(URL);
  await page.locator('[data-action="skip-onboarding"]').click();
  await page.locator('#kick-off').waitFor();
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('derbyday.save.v1')); s.xp = 300; s.unlocksSeen = ['squad','local2p','link','practice','ranked','club','replays','drills']; localStorage.setItem('derbyday.save.v1', JSON.stringify(s)); });
  const p2 = await c.newPage(); await p2.addInitScript(() => { window.__e2eSkipTabGuard = true; });
  await p2.goto(URL); await p2.locator('[data-screen="club"]').click();
  await p2.locator('#replay-tutorial').waitFor();
  await shot(p2, 'drills_club_tab');
  await p2.locator('#replay-tutorial').click();
  await p2.waitForTimeout(1500);
  await shot(p2, 'drills_screen');
  console.log((await p2.locator('#app').innerText()).replace(/\n+/g, ' | ').slice(0, 600));
  await browser.close();
})();
