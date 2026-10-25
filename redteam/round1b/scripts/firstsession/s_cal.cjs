const { launch, ctx, URL, logErrors, shot } = require('./lib.cjs');
const { st, Steer } = require('./play.cjs');
(async () => {
  const browser = await launch();
  const c = await ctx(browser, {});
  const page = await c.newPage();
  logErrors(page, 'cal');
  await page.goto(URL);
  await page.locator('#ob-kickoff').click();
  await page.locator('#pitch').waitFor();
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.tick > 10);
  const box = await page.locator('#pitch').boundingBox();
  const steer = new Steer(page, box);
  console.log('box', box, 'cal', JSON.stringify(await steer.calibrate()));
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < 15000) {
    const s = await st(page);
    const target = { x: s.mePos.x + 6, y: s.mePos.y };
    const err = await steer.toward(target, s);
    if (n++ % 5 === 0) console.log(s.tick, s.phase, 'me', s.mePos.x.toFixed(1), s.mePos.y.toFixed(1), 'aim', s.aim && s.aim.x.toFixed(1), s.aim && s.aim.y.toFixed(1), 'err', err.toFixed(1), 'owner', s.owner, 'tip', s.tip);
    await page.waitForTimeout(80);
  }
  await shot(page, 'cal');
  await browser.close();
})();
