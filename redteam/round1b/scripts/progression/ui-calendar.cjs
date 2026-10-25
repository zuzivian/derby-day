// Forfeit cup quarter-finals in the real UI and watch the calendar (and the season review) move.
const { chromium } = require('playwright');
const OUT = '/tmp/rt/progression/out';
const URL = 'file:///tmp/rt/progression/repo/dist/index.html';
const SAVE_KEY = 'derbyday.save.v1';
const CYCLES = Number(process.argv[2] ?? 10);

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
  await page.reload();
  await page.locator('#kick-off').waitFor();
  const readSave = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
  const s0 = await readSave();
  const avg = (s) => { const w = { GK: { goalkeeping: .72, passing: .1, defending: .08, pace: .05, stamina: .05 }, DEF: { defending: .4, pace: .2, passing: .15, stamina: .15, dribbling: .05, shooting: .05 }, MID: { passing: .35, dribbling: .2, stamina: .15, defending: .1, shooting: .1, pace: .1 }, FWD: { shooting: .4, pace: .25, dribbling: .25, passing: .05, stamina: .05 } }; const xi = s.lineup.map((id) => s.squad.find((p) => p.id === id)); return (xi.reduce((t, p) => t + Object.entries(w[p.role]).reduce((a, [k, v]) => a + p.attrs[k] * v, 0), 0) / xi.length).toFixed(1); };
  console.log(`start: week ${s0.week} year ${s0.year} squad ${s0.squad.length} XI avg ${avg(s0)} elo ${s0.club.elo} budget ${s0.budget}`);
  const t0 = Date.now();
  for (let i = 0; i < CYCLES; i++) {
    const c0 = Date.now();
    await page.locator('[data-action="nav"][data-screen="competitions"]').click();
    await page.locator('[data-action="comp-start-cup"]').click();
    await page.locator('[data-action="comp-play"][data-kind="cup"]').click();
    await page.locator('#pitch').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#forfeit').click();
    await page.locator('.modal [data-action="close-result"]').waitFor();
    const res = (await page.locator('.modal').innerText()).replace(/\s+/g, ' ').slice(0, 200);
    await page.locator('.modal [data-action="close-result"]').click();
    if (await page.locator('[data-action="review-close"]').count()) {
      await page.screenshot({ path: `${OUT}/cal-review-${i + 1}.png` });
      const rv = (await page.locator('[aria-labelledby="review-title"]').innerText()).replace(/\s+/g, ' ').slice(0, 600);
      console.log(`  season review after forfeit ${i + 1}: ${rv}`);
      await page.locator('[data-action="review-close"]').click();
    }
    await page.locator('[data-action="nav"][data-screen="competitions"]').click();
    await page.locator('[data-action="comp-sim-cup"]').click();
    await page.locator('[data-action="comp-close"][data-kind="cup"]').click();
    const s = await readSave();
    const wk = await page.locator('.stat.week .stat-num').innerText();
    console.log(`cycle ${i + 1}: ${((Date.now() - c0) / 1000).toFixed(1)} s, week ${s.week} year ${s.year} header "${wk}" elo ${s.club.elo} budget ${s.budget} xp ${s.xp} | result: ${i === 0 ? res : ''}`);
  }
  const s1 = await readSave();
  console.log(`end after ${((Date.now() - t0) / 1000).toFixed(0)} s: week ${s1.week} year ${s1.year} squad ${s1.squad.length} XI avg ${avg(s1)} elo ${s1.club.elo} budget ${s1.budget} xp ${s1.xp}`);
  await page.locator('[data-action="nav"][data-screen="squad"]').click();
  await page.screenshot({ path: `${OUT}/cal-squad.png`, fullPage: true });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
