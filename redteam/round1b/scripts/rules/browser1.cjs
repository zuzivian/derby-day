const { chromium } = require('playwright');
const { openApp, startRanked, SEL } = require('/tmp/rt/rules/repo/tests/e2e/lib/helpers.cjs');
const OUT = '/tmp/rt/rules/out/shots';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const W = Number(process.env.W || 1280), H = Number(process.env.H || 800);
  const t = { newPage: async (o) => { const ctx = await browser.newContext(o); await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); return ctx.newPage(); } };
  const page = await openApp(t, { width: W, height: H, prefs: { halfSeconds: 600 }, e2eHook: true, renderer: '3d' });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'kickoff', null, { timeout: 20000 });
  const box = await page.locator(SEL.pitch).boundingBox();
  console.log('renderer', await page.evaluate(() => document.querySelector('#pitch').dataset.renderer));
  // Kick-off: hold the pointer far to the right (upfield for the home side) and keep it moving a little.
  const info = () => page.evaluate(() => { const s = window.__derbyMatch; const k = s.players[s.controlled[0]]; return { tick: s.tick, phase: s.phase, owner: s.ball.owner, ctl: s.controlled[0], x: +k.pos.x.toFixed(1), y: +k.pos.y.toFixed(1), ballX: +s.ball.pos.x.toFixed(1), kicks: s.events.filter((e) => e.kind !== 'restart' && e.kind !== 'restartTaken').map((e) => e.kind) }; });
  const taker = await page.evaluate(() => window.__derbyMatch.ball.owner);
  console.log('kick-off taker', taker, await info());
  const startTick = await page.evaluate(() => window.__derbyMatch.tick);
  let i = 0;
  for (let k = 0; k < 400; k++) {
    const st = await info();
    await page.mouse.move(box.x + box.width * (0.93 + 0.02 * (k % 2)), box.y + box.height * 0.5);
    if (st.phase === 'play' && (i === 0 && st.tick > startTick + 50 + 40 || i === 1 && st.tick > startTick + 50 + 150)) {
      await page.screenshot({ path: `${OUT}/kickoff-dribble-${W}-${i}.png` });
      console.log('shot', i, st, 'taker still on the ball:', st.owner === taker);
      i++;
      if (i === 2) break;
    }
    await page.waitForTimeout(60);
  }
  await browser.close();
})();
