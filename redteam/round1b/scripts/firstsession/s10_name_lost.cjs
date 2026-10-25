const { launch, ctx, URL, shot } = require('./lib.cjs');
const { ffHalf } = require('./newbie.cjs');
(async () => {
  const browser = await launch();
  for (const [w, h, touch] of [[1280, 800, false], [390, 844, true]]) {
    const c = await ctx(browser, { width: w, height: h, touch });
    const page = await c.newPage();
    await page.goto(URL);
    await page.locator('#ob-kickoff').click();
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
    await ffHalf(page);
    await page.waitForFunction(() => window.__derbyMatch.half === 2 && window.__derbyMatch.phase === 'play', null, { timeout: 90000 });
    await ffHalf(page);
    await page.locator('.ob-celebrate').waitFor({ timeout: 60000 });
    await page.locator('[data-ob="next"]').click();
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('derbyday.save.v1')).club.name);
    await page.locator('#ob-name').fill('Harbour Lights');
    await shot(page, `name_typed_${w}`);
    // the big primary button, as a player would after typing
    await page.locator('[data-ob="done"]').click();
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('derbyday.save.v1')).club.name);
    const header = await page.locator('.topbar .club-name').innerText();
    console.log(w, JSON.stringify({ before, typed: 'Harbour Lights', savedAfter: after, header, toast: await page.locator('.toast').count() }));
    await shot(page, `name_lost_home_${w}`);
    await c.close();
  }
  await browser.close();
})();
