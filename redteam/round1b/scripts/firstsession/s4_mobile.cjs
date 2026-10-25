const { launch, ctx, URL, logErrors, shot } = require('./lib.cjs');
const { st } = require('./play.cjs');
const { ffHalf } = require('./newbie.cjs');
let T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const TAG = 'mj';
async function textOf(page, sel = '#app') { return (await page.locator(sel).first().innerText()).replace(/\n+/g, ' | '); }
async function tabs(page) { return page.$$eval('[data-action="nav"][data-screen]', (els) => els.map((e) => e.dataset.screen)); }
async function tap(page, sel) { const b = await page.locator(sel).first().boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); }
async function finishMatch(page, tag) {
  let s = await st(page);
  if (s.half === 1) {
    await ffHalf(page);
    await page.waitForFunction(() => window.__derbyMatch.phase === 'halftime', null, { timeout: 60000 });
    await page.waitForFunction(() => window.__derbyMatch.half === 2 && window.__derbyMatch.phase === 'play', null, { timeout: 90000 });
  }
  await ffHalf(page);
  await page.waitForFunction(() => window.__derbyMatch.phase === 'fulltime', null, { timeout: 60000 });
  await page.waitForTimeout(500);
  await shot(page, `${tag}_fulltime`);
}
(async () => {
  const browser = await launch();
  const c = await ctx(browser, { width: 390, height: 844, touch: true });
  const page = await c.newPage();
  logErrors(page, TAG);
  const cdp = await c.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) });
  T0 = Date.now();
  await page.goto(URL);
  await page.locator('#ob-kickoff').waitFor();
  log('welcome');
  await tap(page, '#ob-kickoff');
  await page.locator('#pitch').waitFor();
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.tick > 5, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  await shot(page, `${TAG}02_match_start`);
  const layout = await page.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect().toJSON() : null; };
    return { pitch: r('#pitch'), wrap: r('.pitch-wrap'), pass: r('#pad-pass'), shoot: r('#pad-shoot'), radar: r('.hud-radar'), hint: r('#controls-hint'), hintText: document.getElementById('controls-hint')?.innerText, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, ih: innerHeight };
  });
  log('layout', JSON.stringify(layout));
  const box = layout.pitch;
  // steering finger state
  let finger = null; // {x,y}
  const down = async (x, y) => { finger = { x, y }; await touch('touchStart', [{ x, y, id: 1 }]); };
  const move = async (x, y) => { x = Math.max(box.x + 4, Math.min(box.x + box.width - 4, x)); y = Math.max(box.y + 4, Math.min(box.y + box.height - 4, y)); finger = { x, y }; await touch('touchMove', [{ x, y, id: 1 }]); };
  const up = async () => { if (finger) await touch('touchEnd', []); finger = null; };
  let kx = 9, ky = -7;
  const toward = async (target, s) => {
    if (!finger) await down(box.x + box.width / 2, box.y + box.height * 0.55);
    if (!s.aim) { await move(finger.x + 1, finger.y); return; }
    const ex = target.x - s.aim.x, ey = target.y - s.aim.y;
    await move(finger.x + ex * kx * 0.7, finger.y + ey * ky * 0.7);
  };
  const tips = [];
  let lastTip = null, heldSince = null;
  const tPlay = Date.now();
  const tapPad = async (id, ms = 120) => {
    const b = layout[id];
    const pts = finger ? [{ x: finger.x, y: finger.y, id: 1 }] : [];
    await touch('touchStart', [...pts, { x: b.x + b.width / 2, y: b.y + b.height / 2, id: 2 }]);
    await page.waitForTimeout(ms);
    await touch('touchEnd', pts.length ? pts : []);
    if (finger) await touch('touchMove', pts); // keep steering finger
  };
  // calibrate: put a finger down, measure aim change
  await down(box.x + box.width / 2, box.y + box.height * 0.55); await page.waitForTimeout(300);
  const a = (await st(page)).aim; await move(finger.x + 60, finger.y); await page.waitForTimeout(300); const b = (await st(page)).aim; await move(finger.x, finger.y + 60); await page.waitForTimeout(300); const cc = (await st(page)).aim;
  if (a && b && cc) { kx = 60 / ((b.x - a.x) || 1e-3); ky = 60 / ((cc.y - b.y) || 1e-3); }
  log('touch calibration', JSON.stringify({ a, b, cc, kx, ky }));
  const acts = { pass: 0, shoot: 0 };
  while (Date.now() - tPlay < 70000) {
    const s = await st(page);
    if (!s || s.phase === 'fulltime') break;
    if (s.tip && s.tip !== lastTip) {
      const text = await page.locator('.coach-tip').innerText().catch(() => '');
      const tb = await page.locator('.coach-tip').boundingBox().catch(() => null);
      tips.push(s.tip);
      log(`TIP ${s.tip} @${s.tick} ${s.phase} owner ${s.owner} me ${s.me}: ${text.replace(/\n/g, ' ')} box ${JSON.stringify(tb)}`);
      await shot(page, `${TAG}03_tip_${s.tip}`);
    }
    lastTip = s.tip;
    if (!['play', 'restart', 'kickoff'].includes(s.phase)) { await page.waitForTimeout(150); continue; }
    const me = s.mePos;
    if (s.owner === s.me) {
      heldSince ??= Date.now();
      if (me.x > 80 && Date.now() - heldSince > 500) { await toward({ x: 105, y: 34 }, s); await page.waitForTimeout(80); await tapPad('shoot', 150); acts.shoot++; heldSince = null; }
      else if (Date.now() - heldSince > 1500) {
        const m = s.mates.filter((q) => q.x > me.x - 4 && q.role !== 'GK').sort((p, q) => Math.hypot(p.x - me.x, p.y - me.y) - Math.hypot(q.x - me.x, q.y - me.y))[0];
        if (m) { for (let k = 0; k < 2; k++) { await toward(m, await st(page)); await page.waitForTimeout(60); } await tapPad('pass', 120); acts.pass++; heldSince = null; }
      } else await toward({ x: me.x + 7, y: me.y + (34 - me.y) * 0.15 }, s);
    } else { heldSince = null; await toward(s.ball, s); }
    await page.waitForTimeout(80);
  }
  await up();
  log('acts', JSON.stringify(acts), 'tips', tips.join(','));
  await finishMatch(page, `${TAG}04`);
  await page.locator('.ob-celebrate').waitFor({ timeout: 60000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/rt/firstsession/out/${TAG}05_celebrate.png`, fullPage: true });
  log('celebrate', await textOf(page));
  log('celebrate fold', JSON.stringify(await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, next: document.querySelector('[data-ob="next"]').getBoundingClientRect().toJSON() }))));
  await tap(page, '[data-ob="next"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/rt/firstsession/out/${TAG}06_name.png`, fullPage: true });
  await tap(page, '[data-ob="skip"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `/tmp/rt/firstsession/out/${TAG}07_home_l2.png`, fullPage: true });
  await shot(page, `${TAG}07_home_l2_fold`);
  log('home L2 tabs', await tabs(page), 'mark', await page.locator('.tab-mark').count());
  for (const n of [2, 3]) {
    await tap(page, '#kick-off');
    await page.locator('#pitch').waitFor();
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
    // nudge the match so the result is a 0-0 / whatever; just fast-forward
    await page.waitForTimeout(3000);
    await finishMatch(page, `${TAG}1${n}`);
    await page.locator('.modal').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `/tmp/rt/firstsession/out/${TAG}1${n}_result.png`, fullPage: false });
    log(`result${n}`, await textOf(page, '.modal'));
    await tap(page, '[data-action="close-result"]');
    await page.waitForTimeout(600);
    if (await page.locator('#levelup-title').count()) {
      await page.waitForTimeout(1500);
      await shot(page, `${TAG}1${n}_levelup`);
      log(`levelup${n}`, await textOf(page, '.modal'));
      const lb = await page.locator('[data-action="levelup-close"]').boundingBox();
      log('levelup close btn', JSON.stringify(lb));
      await page.locator('[data-action="levelup-close"]').scrollIntoViewIfNeeded();
      await tap(page, '[data-action="levelup-close"]');
      await page.waitForTimeout(600);
    }
    await shot(page, `${TAG}1${n}_home`);
    log(`home after ${n}`, await tabs(page), 'mark', (await page.locator('.tab-mark').count()) ? await page.locator('.tab-mark').innerText() : 'none');
    log('mark box', JSON.stringify(await page.evaluate(() => { const m = document.querySelector('.tab-mark'); const t = m && document.querySelector(`[data-screen="${m.dataset.mark}"]`); return m && { mark: m.getBoundingClientRect().toJSON(), tab: t.getBoundingClientRect().toJSON(), iw: innerWidth }; })));
  }
  log('DONE');
  await browser.close();
})().catch((e) => { console.log('FAILED', e); process.exit(1); });
