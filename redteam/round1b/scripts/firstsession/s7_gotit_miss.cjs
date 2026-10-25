const { launch, ctx, URL, shot } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  const c = await ctx(browser, { width: 390, height: 844, touch: true });
  const page = await c.newPage();
  await page.goto(URL);
  await page.locator('#ob-kickoff').click();
  await page.locator('.coach-tip:not([hidden])').waitFor({ timeout: 60000 });
  await page.waitForTimeout(600);
  const before = await page.locator('.pitch-cam').innerText();
  const x = await page.locator('.coach-x').boundingBox();
  // a thumb aimed at "Got it", landing 5 px below its bottom edge
  await page.touchscreen.tap(x.x + x.width / 2, x.y + x.height + 5);
  await page.waitForTimeout(800);
  const after = await page.locator('.pitch-cam').innerText();
  const tipStill = await page.locator('.coach-tip:not([hidden])').count();
  console.log(JSON.stringify({ gotItSize: [x.width, x.height], camBefore: before, camAfter: after, tipStillShown: tipStill }));
  await shot(page, 'gotit_miss_390');
  await browser.close();
})();
