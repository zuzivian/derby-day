const { launch, ctx, URL, logErrors, shot } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  for (const scheme of ['light', 'dark']) {
    const c = await ctx(browser, { width: 390, height: 844, touch: true });
    const page = await c.newPage();
    await page.emulateMedia({ colorScheme: scheme });
    logErrors(page, 'mob');
    await page.goto(URL);
    await page.locator('#ob-kickoff').waitFor();
    await page.waitForTimeout(400);
    await shot(page, `m01_welcome_${scheme}`);
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, kick: document.getElementById('ob-kickoff').getBoundingClientRect().toJSON(), coarse: matchMedia('(pointer: coarse)').matches }));
    console.log(scheme, JSON.stringify(r));
    await c.close();
  }
  // desktop dark
  const c = await ctx(browser, { width: 1280, height: 800 });
  const page = await c.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(URL);
  await page.locator('#ob-kickoff').waitFor();
  await page.waitForTimeout(300);
  await shot(page, `d01_welcome_dark`);
  await browser.close();
})();
