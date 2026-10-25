const { chromium } = require('playwright');
const URL = 'file:///tmp/rt/progression/repo/dist/index.html';
const SAVE_KEY = 'derbyday.save.v1';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.locator('[data-action="skip-onboarding"]').click();
  await page.locator('#kick-off').waitFor();
  await page.evaluate((k) => { const s = JSON.parse(localStorage.getItem(k)); s.xp = 50 * 8 * 7; delete s.unlocksSeen; localStorage.setItem(k, JSON.stringify(s)); }, SAVE_KEY);
  await page.reload(); await page.locator('#kick-off').waitFor();
  const readSave = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
  const b0 = (await readSave()).budget; const t0 = Date.now();
  await page.locator('[data-action="nav"][data-screen="competitions"]').click();
  await page.locator('[data-action="comp-start-season"]').click();
  let last = '';
  for (let d = 0; d < 7; d++) {
    await page.locator('[data-action="comp-play"][data-kind="season"]').click();
    await page.locator('#pitch').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#forfeit').click();
    await page.locator('.modal [data-action="close-result"]').waitFor();
    last = (await page.locator('.modal').innerText()).replace(/\s+/g, ' ');
    await page.locator('.modal [data-action="close-result"]').click();
    if (await page.locator('[data-action="levelup-close"]').count()) await page.locator('[data-action="levelup-close"]').click();
  }
  const s = await readSave();
  console.log(`7 league forfeits in ${((Date.now() - t0) / 1000).toFixed(0)} s: budget ${b0} -> ${s.budget} (+${s.budget - b0}); last result: ${last.slice(0, 420)}`);
  await page.screenshot({ path: '/tmp/rt/progression/out/league-forfeit.png' });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
