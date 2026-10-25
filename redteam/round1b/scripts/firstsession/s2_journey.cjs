const { launch, ctx, URL, logErrors, shot } = require('./lib.cjs');
const { st } = require('./play.cjs');
const { playFor, ffHalf, click } = require('./newbie.cjs');
const W = Number(process.env.W || 1280), H = Number(process.env.H || 800), TAG = process.env.TAG || 'j';
const PLAYMS = Number(process.env.PLAYMS || 90000);
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
let T0 = Date.now();
async function textOf(page) { return (await page.locator('#app').innerText()).replace(/\n+/g, ' | '); }
async function tabs(page) { return page.$$eval('[data-action="nav"][data-screen]', (els) => els.map((e) => e.dataset.screen)); }
async function finishMatch(page, tag) {
  // fast-forward to half time, then to full time
  let s = await st(page);
  if (s.half === 1) {
    log('FF to half time', JSON.stringify(await ffHalf(page)));
    await page.waitForFunction(() => window.__derbyMatch.phase === 'halftime', null, { timeout: 60000 });
    await page.waitForTimeout(600);
    await shot(page, `${tag}_halftime`);
    log('halftime text', (await page.locator('.pitch-wrap').innerText()).replace(/\n+/g, ' | ').slice(0, 300));
    await page.waitForFunction(() => window.__derbyMatch.half === 2 && window.__derbyMatch.phase === 'play', null, { timeout: 90000 });
  }
  log('FF to full time', JSON.stringify(await ffHalf(page)));
  await page.waitForFunction(() => window.__derbyMatch.phase === 'fulltime', null, { timeout: 60000 });
  const score = (await st(page)).score;
  await page.waitForTimeout(400);
  await shot(page, `${tag}_fulltime`);
  log('fulltime score', score);
  return score;
}
(async () => {
  const browser = await launch();
  const c = await ctx(browser, { width: W, height: H });
  const page = await c.newPage();
  logErrors(page, TAG);
  T0 = Date.now();
  await page.goto(URL);
  await page.locator('#ob-kickoff').waitFor();
  log('welcome visible');
  // colour of the club names on the welcome
  const names = await page.$$eval('.ob-versus .side-name', (els) => els.map((e) => { const cs = getComputedStyle(e); let p = e; let bg = 'rgba(0, 0, 0, 0)'; while (p && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) { bg = getComputedStyle(p).backgroundColor; p = p.parentElement; } return { text: e.innerText, color: cs.color, bg }; }));
  log('welcome names', JSON.stringify(names));
  await shot(page, `${TAG}01_welcome`);
  const tClick = Date.now();
  await page.locator('#ob-kickoff').click();
  await page.locator('#pitch').waitFor();
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
  log('first match live after click ms', Date.now() - tClick, 'tick', (await st(page)).tick);
  // ---- Match 1: play for real
  const r1 = await playFor(page, PLAYMS, { tag: `${TAG}02` , log });
  log('match1 acts', JSON.stringify(r1.acts), 'tips', r1.tips.map((t) => `${t.id}@${t.tick}`).join(','));
  await shot(page, `${TAG}03_after_play`);
  const prefsMid = await page.evaluate(() => localStorage.getItem('derbyday.prefs.v1'));
  log('prefs mid match1', prefsMid);
  await finishMatch(page, `${TAG}04`);
  // celebration
  await page.locator('.ob-celebrate').waitFor({ timeout: 60000 });
  await page.waitForTimeout(500);
  await shot(page, `${TAG}05_celebrate`);
  log('celebrate:', await textOf(page));
  await page.locator('[data-ob="next"]').click();
  await page.waitForTimeout(300);
  await shot(page, `${TAG}06_nameclub`);
  log('name step:', await textOf(page));
  await page.locator('[data-ob="reroll-name"]').click();
  await page.waitForTimeout(200);
  await page.locator('#ob-name').fill('Harbour Lights');
  await page.locator('[data-ob="rename"]').click();
  await page.waitForTimeout(300);
  await shot(page, `${TAG}07_renamed`);
  log('after rename:', await textOf(page));
  await page.locator('[data-ob="done"]').click();
  await page.waitForTimeout(600);
  await shot(page, `${TAG}08_home_l2`);
  log('home L2 tabs', await tabs(page), 'mark?', await page.locator('.tab-mark').count(), 'modal?', await page.locator('.modal').count());
  log('home L2 text:', await textOf(page));
  const save1 = await page.evaluate(() => JSON.parse(localStorage.getItem('derbyday.save.v1')));
  const prefs1 = await page.evaluate(() => JSON.parse(localStorage.getItem('derbyday.prefs.v1')));
  log('after match1 xp', save1.xp, 'unlocksSeen', JSON.stringify(save1.unlocksSeen), 'prefs', JSON.stringify(prefs1));
  // visit squad
  if ((await tabs(page)).includes('squad')) {
    await page.locator('[data-screen="squad"]').click(); await page.waitForTimeout(400);
    await shot(page, `${TAG}09_squad`);
    await page.locator('[data-screen="home"]').click(); await page.waitForTimeout(300);
  }
  // ---- Match 2
  for (const n of [2, 3]) {
    const ko = page.locator('#kick-off');
    log(`match${n} kickoff button action`, await ko.getAttribute('data-action'), 'text', await page.locator('.hero').innerText().then((t) => t.replace(/\n+/g, ' | ')));
    await ko.click();
    await page.locator('#pitch').waitFor();
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
    const r = await playFor(page, Number(process.env.PLAYMS2 || 30000), { tag: `${TAG}1${n}`, log });
    log(`match${n} acts`, JSON.stringify(r.acts), 'tips', r.tips.map((t) => `${t.id}@${t.tick}`).join(','));
    await finishMatch(page, `${TAG}1${n}`);
    await page.locator('.modal').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(500);
    await shot(page, `${TAG}1${n}_result`);
    log(`result${n}:`, (await page.locator('.modal').first().innerText()).replace(/\n+/g, ' | '));
    // close result (button), then maybe a level-up dialog
    await page.locator('[data-action="close-result"]').click();
    await page.waitForTimeout(500);
    if (await page.locator('#levelup-title').count()) {
      await shot(page, `${TAG}1${n}_levelup`);
      log(`levelup${n}:`, (await page.locator('.modal').first().innerText()).replace(/\n+/g, ' | '));
      await page.locator('[data-action="levelup-close"]').click();
      await page.waitForTimeout(500);
    }
    await shot(page, `${TAG}1${n}_home`);
    log(`home after match${n} tabs`, await tabs(page), 'mark', await page.locator('.tab-mark').count() ? await page.locator('.tab-mark').innerText() : 'none');
    const sv = await page.evaluate(() => JSON.parse(localStorage.getItem('derbyday.save.v1')));
    log(`after match${n} xp`, sv.xp, 'history', sv.history.length);
  }
  log('DONE');
  await browser.close();
})().catch((e) => { console.log('FAILED', e); process.exit(1); });
