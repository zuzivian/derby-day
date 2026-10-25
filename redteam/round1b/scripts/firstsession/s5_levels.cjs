const { launch, ctx, URL, logErrors, shot } = require('./lib.cjs');
const { st } = require('./play.cjs');
const { ffHalf } = require('./newbie.cjs');
let T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const SAVE = 'derbyday.save.v1', PREFS = 'derbyday.prefs.v1';
async function tabs(page) { return page.$$eval('[data-action="nav"][data-screen]', (els) => els.map((e) => e.dataset.screen)); }
async function finishMatch(page) {
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
  let s = await st(page);
  if (s.half === 1) { await ffHalf(page); await page.waitForFunction(() => window.__derbyMatch.half === 2 && window.__derbyMatch.phase === 'play', null, { timeout: 90000 }); }
  await ffHalf(page);
  await page.waitForFunction(() => window.__derbyMatch.phase === 'fulltime', null, { timeout: 60000 });
}
async function markInfo(page) {
  return page.evaluate(() => { const m = document.querySelector('.tab-mark'); if (!m) return null; const t = document.querySelector(`[data-action="nav"][data-screen="${m.dataset.mark}"]`); const tr = t.getBoundingClientRect(); const mr = m.getBoundingClientRect(); return { screen: m.dataset.mark, text: m.innerText.replace(/\n/g, ' | '), tab: { l: tr.left, r: tr.right, t: tr.top, b: tr.bottom }, mark: { l: mr.left, r: mr.right, t: mr.top, b: mr.bottom }, iw: innerWidth, tabsScroll: document.querySelector('.tabs').scrollWidth, tabsW: document.querySelector('.tabs').clientWidth }; });
}
async function run(browser, { width, height, touch, tag }) {
  const c = await ctx(browser, { width, height, touch });
  let page = await c.newPage();
  logErrors(page, tag);
  await page.goto(URL);
  await page.locator('#ob-kickoff').click();
  await finishMatch(page);
  await page.locator('.ob-celebrate').waitFor({ timeout: 60000 });
  await page.locator('[data-ob="skip"]').click();
  await page.locator('#kick-off').waitFor();
  for (const [lvl, xp, add] of [[4, 590, ['ranked', 'club', 'replays', 'drills']], [5, 990, ['training', 'practice-normal']]]) {
    await page.evaluate(([S, P, xp, add]) => {
      const s = JSON.parse(localStorage.getItem(S)); s.xp = xp; s.unlocksSeen = [...new Set([...(s.unlocksSeen || []), ...add])]; localStorage.setItem(S, JSON.stringify(s));
      const p = JSON.parse(localStorage.getItem(P)); for (const m of ['club', 'training']) if (add.includes(m) && !p.marks.includes(m)) p.marks.push(m); localStorage.setItem(P, JSON.stringify(p));
    }, [SAVE, PREFS, xp, add]);
    const next = await c.newPage();
    await next.addInitScript(() => { window.__e2eSkipTabGuard = true; });
    logErrors(next, tag);
    await next.goto(URL);
    await next.locator('#kick-off').waitFor();
    await page.close().catch(() => {});
    page = next;
    log(tag, `before L${lvl}: tabs`, await tabs(page), 'kickoff', await page.locator('#kick-off').getAttribute('data-action'), 'modal', await page.locator('.modal').count(), 'mark', JSON.stringify(await markInfo(page)));
    await page.locator('#kick-off').click();
    await page.locator('#pitch').waitFor();
    await finishMatch(page);
    await page.locator('.modal').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    await shot(page, `${tag}_L${lvl}_result`);
    await page.locator('[data-action="close-result"]').click();
    await page.waitForTimeout(800);
    const lu = await page.locator('#levelup-title').count();
    if (lu) {
      await page.waitForTimeout(1200);
      await shot(page, `${tag}_L${lvl}_levelup`);
      log(tag, `levelup L${lvl}:`, (await page.locator('.modal').first().innerText()).replace(/\n+/g, ' | '));
      await page.locator('[data-action="levelup-close"]').click();
      await page.waitForTimeout(800);
    } else log(tag, `NO level-up dialog at L${lvl}`);
    await shot(page, `${tag}_L${lvl}_home`);
    log(tag, `after L${lvl}: tabs`, await tabs(page), 'mark', JSON.stringify(await markInfo(page)));
    log(tag, 'home cards', await page.$$eval('.mode-grid [data-mode]', (els) => els.map((e) => `${e.dataset.mode}${e.classList.contains('locked') ? '(locked ' + e.dataset.lockedLevel + ')' : ''}`)));
    log(tag, 'strip', (await page.locator('.topbar').innerText()).replace(/\n+/g, ' | '));
  }
  await c.close();
}
(async () => {
  const browser = await launch();
  T0 = Date.now();
  await run(browser, { width: 1280, height: 800, tag: 'lv_d' });
  await run(browser, { width: 390, height: 844, touch: true, tag: 'lv_m' });
  log('DONE');
  await browser.close();
})().catch((e) => { console.log('FAILED', e); process.exit(1); });
