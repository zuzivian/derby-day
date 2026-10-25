const { chromium } = require('playwright');
const URL = 'file:///tmp/rt/progression/repo/dist/index.html';
const SAVE_KEY = 'derbyday.save.v1';
const total = (L) => 50 * L * (L - 1);
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [xp, w, h, tag] of [[total(51) + 1234, 1280, 800, 'l51-1280'], [total(81) + 500, 390, 844, 'l81-390'], [total(99) + 9900, 1280, 800, 'l99max-1280']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto(URL);
    await page.locator('[data-action="skip-onboarding"]').click();
    await page.locator('#kick-off').waitFor();
    await page.evaluate(([k, xp]) => { const s = JSON.parse(localStorage.getItem(k)); s.xp = xp; delete s.unlocksSeen; localStorage.setItem(k, JSON.stringify(s)); }, [SAVE_KEY, xp]);
    await page.reload(); await page.locator('#kick-off').waitFor();
    await page.locator('[data-action="nav"][data-screen="club"]').click();
    await page.locator('#next-unlock').scrollIntoViewIfNeeded();
    const txt = (await page.locator('.level-panel').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    const head = await page.locator('#xp-text').innerText();
    console.log(tag, '| header:', head, '| panel:', txt);
    await page.locator('.level-panel').screenshot({ path: `/tmp/rt/progression/out/panel-${tag}.png` });
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
