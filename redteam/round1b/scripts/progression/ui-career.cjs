// Drive the real build through a short career and compare what the UI shows with the save.
const { chromium } = require('playwright');
const OUT = '/tmp/rt/progression/out';
const URL = 'file:///tmp/rt/progression/repo/dist/index.html';
const SAVE_KEY = 'derbyday.save.v1';
const PREFS_KEY = 'derbyday.prefs.v1';
const total = (L) => 50 * L * (L - 1);
function progress(xp) { let level = 1; while (level < 99 && total(level + 1) <= xp) level++; return { level, into: xp - total(level), needed: 100 * level }; }
const fmtMoney = (n) => (n >= 1e6 ? `ƒ${(n / 1e6).toFixed(2)}m` : `ƒ${Math.round(n / 1000)}k`);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(([key]) => { window.__e2e = true; if (!localStorage.getItem('derbyday.save.v1')) localStorage.setItem(key, JSON.stringify({ halfSeconds: 3, controls: 'mouse' })); }, [PREFS_KEY]);
  await page.goto(URL);
  await page.locator('#ob-kickoff').waitFor();
  const readSave = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SAVE_KEY);
  const log = [];

  async function setScore(gf, ga) {
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase !== 'fulltime', null, { timeout: 30000 });
    await page.evaluate(([gf, ga]) => {
      const m = window.__derbyMatch;
      m.score = [gf, ga];
      for (let i = 0; i < gf; i++) m.goals.push({ team: 0, scorer: 'A. Test', minute: 10 + i });
      for (let i = 0; i < ga; i++) m.goals.push({ team: 1, scorer: 'B. Opp', minute: 50 + i });
    }, [gf, ga]);
  }
  async function header(tag) {
    const s = await readSave();
    const p = progress(s.xp);
    const ui = await page.evaluate(() => {
      const t = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
      const bar = document.querySelector('.topbar [role="progressbar"]');
      return { xpText: t('#xp-text'), badge: t('.level-badge'), now: bar?.getAttribute('aria-valuenow'), max: bar?.getAttribute('aria-valuemax'), elo: t('.club-elo'), money: t('.stat.money .stat-num'), rank: t('.stat.rank .stat-num'), week: t('.stat.week .stat-num'), sessions: t('.stat.sessions .stat-num'), tabs: [...document.querySelectorAll('[data-action="nav"]')].map((e) => e.dataset.screen) };
    });
    const want = { xpText: `Level ${p.level} · ${p.into.toLocaleString('en-GB')} / ${p.needed.toLocaleString('en-GB')} XP`, badge: String(p.level), now: String(p.into), max: String(p.needed), elo: `Elo ${s.club.elo}`, money: fmtMoney(s.budget), sessions: String(s.trainingPoints) };
    const mism = Object.keys(want).filter((k) => ui[k] !== null && ui[k] !== want[k]).map((k) => `${k}: ui=${JSON.stringify(ui[k])} save=${JSON.stringify(want[k])}`);
    log.push(`[${tag}] xp=${s.xp} L${p.level} elo=${s.club.elo} budget=${s.budget} tp=${s.trainingPoints} | ui ${JSON.stringify(ui)} | ${mism.length ? 'MISMATCH ' + mism.join('; ') : 'ok'}`);
    return s;
  }

  // 1. First match
  await page.locator('#ob-kickoff').click();
  await page.locator('#pitch').waitFor();
  await setScore(1, 0);
  await page.locator('.ob-celebrate').waitFor({ timeout: 90000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/ui-01-celebrate.png` });
  const cel = await page.locator('.ob-celebrate').innerText();
  let s = await readSave();
  log.push(`[first match] save.xp=${s.xp} celebrate: ${cel.replace(/\s+/g, ' ').slice(0, 300)}`);
  await page.locator('[data-ob="skip"]').first().click();
  await page.locator('#kick-off').waitFor();
  await header('after first match');
  await page.screenshot({ path: `${OUT}/ui-02-home-l2.png` });

  // 2. a series of matches through Kick off, with level-up dialogs
  const plan = [[2, 1], [3, 0], [1, 1], [2, 0], [0, 1], [3, 1], [2, 2], [4, 0], [1, 0], [2, 1], [3, 0], [1, 2]];
  let k = 0;
  for (const [gf, ga] of plan) {
    k++;
    const before = await readSave();
    const action = await page.locator('#kick-off').getAttribute('data-action');
    const oppShown = (await page.locator('.hero').innerText()).replace(/\s+/g, ' ').slice(0, 160);
    await page.locator('#kick-off').click();
    await page.locator('#pitch').waitFor();
    await setScore(gf, ga);
    await page.locator('.modal [data-action="close-result"]').waitFor({ timeout: 90000 });
    await page.waitForTimeout(2600);
    const resText = (await page.locator('.modal').innerText()).replace(/\s+/g, ' ');
    const after = await readSave();
    const m = /\+([\d,]+) XP/.exec(resText);
    const shownXp = m ? Number(m[1].replace(/,/g, '')) : null;
    const moneyShown = /ƒ[\d.]+[mk]/.exec(resText)?.[0] ?? null;
    log.push(`[match ${k} ${action} ${gf}-${ga}] hero: ${oppShown} | xp ${before.xp}->${after.xp} (+${after.xp - before.xp}) shown +${shownXp} | budget +${after.budget - before.budget} shown ${moneyShown} | elo ${before.club.elo}->${after.club.elo} | result: ${resText.slice(0, 420)}`);
    if (k === 3 || k === 8) await page.screenshot({ path: `${OUT}/ui-03-result-${k}.png` });
    await page.locator('.modal [data-action="close-result"]').click();
    await page.waitForTimeout(300);
    for (let g = 0; g < 3; g++) {
      if (await page.locator('[aria-labelledby="levelup-title"]').count()) {
        const lu = (await page.locator('[aria-labelledby="levelup-title"]').innerText()).replace(/\s+/g, ' ');
        log.push(`   level-up dialog: ${lu.slice(0, 300)}`);
        if (k <= 12) await page.screenshot({ path: `${OUT}/ui-04-levelup-${k}.png` });
        await page.locator('[data-action="levelup-close"]').click();
        await page.waitForTimeout(300);
      }
      if (await page.locator('.coach-mark [data-action], [data-action="mark-ok"]').count()) {
        /* leave marks */
      }
    }
    await header(`after match ${k}`);
  }
  await page.screenshot({ path: `${OUT}/ui-05-home-final-1280.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/ui-06-home-final-390.png` });
  log.push('errors: ' + JSON.stringify(errors));
  require('fs').writeFileSync(`${OUT}/ui-career.log`, log.join('\n'));
  console.log(log.join('\n'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
