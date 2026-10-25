// 1) Does reloading Home re-roll the ranked opponent? 2) Does reloading mid-match while losing dodge the loss?
const { chromium } = require('playwright');
const OUT = '/tmp/rt/progression/out';
const URL = 'file:///tmp/rt/progression/repo/dist/index.html';
const SAVE_KEY = 'derbyday.save.v1';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.__e2e = true; });
  await page.goto(URL);
  await page.locator('[data-action="skip-onboarding"]').click();
  await page.locator('#kick-off').waitFor();
  await page.evaluate((k) => { const s = JSON.parse(localStorage.getItem(k)); s.xp = 50 * 10 * 9; delete s.unlocksSeen; localStorage.setItem(k, JSON.stringify(s)); }, SAVE_KEY);
  const readSave = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
  const heroOpp = async () => (await page.locator('.hero .hero-side').nth(1).innerText()).replace(/\s+/g, ' ').trim();
  const opps = [];
  for (let i = 0; i < 6; i++) {
    await page.reload();
    await page.locator('#kick-off').waitFor();
    if (await page.locator('[data-action="levelup-close"]').count()) await page.locator('[data-action="levelup-close"]').click();
    opps.push(await heroOpp());
  }
  console.log('hero opponent after each reload:', JSON.stringify(opps));

  // Reload mid-match while losing.
  const before = await readSave();
  await page.locator('#kick-off').click();
  await page.locator('#pitch').waitFor();
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
  await page.evaluate(() => { const m = window.__derbyMatch; m.score = [0, 3]; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/dodge-1-losing.png` });
  const label = await page.evaluate(() => document.querySelector('.hud, #hud, .scoreboard')?.textContent?.replace(/\s+/g, ' ').slice(0, 120));
  await page.reload();
  await page.locator('#kick-off').waitFor();
  const after = await readSave();
  const eloShown = await page.locator('.club-elo').innerText();
  await page.screenshot({ path: `${OUT}/dodge-2-after-reload.png` });
  console.log(`mid-match HUD: ${label}`);
  console.log(`before: history=${before.history.length} elo=${before.club.elo} played=${before.club.played} lost=${before.club.lost}`);
  console.log(`after reload: history=${after.history.length} elo=${after.club.elo} played=${after.club.played} lost=${after.club.lost} header="${eloShown}" news tail: ${after.news.slice(-2).join(' | ')}`);

  // Same situation, forfeiting through the menu, for comparison.
  await page.locator('#kick-off').click();
  await page.locator('#pitch').waitFor();
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
  await page.evaluate(() => { window.__derbyMatch.score = [0, 3]; });
  await page.keyboard.press('Escape');
  await page.locator('#forfeit').click();
  await page.locator('.modal [data-action="close-result"]').waitFor();
  const f = await readSave();
  console.log(`forfeit instead: history=${f.history.length} elo=${f.club.elo} (${f.club.elo - after.club.elo}) lost=${f.club.lost}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
