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
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 30000 });
  const box = await page.locator(SEL.pitch).boundingBox();
  // An away attacker's shot goes wide of the home goal: goal kick to the home side (the human).
  await page.evaluate(() => {
    const s = window.__derbyMatch; const b = s.ball;
    const st = s.players.find((p) => p.team === 1 && p.role === 'FWD');
    b.owner = -1; b.receiver = -1; b.pos = { x: 6, y: 24 }; b.vel = { x: -18, y: 0 }; b.z = 0; b.vz = 0; b.lastTouch = st.i; b.kickedBy = st.i;
  });
  await page.waitForFunction(() => { const r = window.__derbyMatch.restart; return r && r.kind === 'goalkick' && r.stage === 'ready'; }, null, { timeout: 60000 });
  const r = await page.evaluate(() => { const s = window.__derbyMatch; return { spot: s.restart.spot, taker: s.restart.taker, ctl: s.controlled[0] }; });
  console.log('goal kick ready', r);
  // Find the screen point over the grass 6 m in front of the ball (pointer -> world is s.humanAim[0]).
  const target = { x: r.spot.x + 6, y: r.spot.y };
  let px = box.x + box.width * 0.3, py = box.y + box.height * 0.6;
  const aimAt = async (x, y) => { await page.mouse.move(x, y); await page.waitForTimeout(250); return page.evaluate(() => window.__derbyMatch.humanAim && window.__derbyMatch.humanAim[0]); };
  for (let it = 0; it < 6; it++) {
    const a = await aimAt(px, py); const ax = await aimAt(px + 20, py); const ay = await aimAt(px, py + 20);
    if (!a || !ax || !ay) { console.log('no aim'); break; }
    const j = [[(ax.x - a.x) / 20, (ay.x - a.x) / 20], [(ax.y - a.y) / 20, (ay.y - a.y) / 20]];
    const det = j[0][0] * j[1][1] - j[0][1] * j[1][0];
    const ex = target.x - a.x, ey = target.y - a.y;
    px += (j[1][1] * ex - j[0][1] * ey) / det; py += (-j[1][0] * ex + j[0][0] * ey) / det;
    if (Math.hypot(ex, ey) < 0.3) break;
  }
  const a = await aimAt(px, py);
  console.log('pointer world', a, 'target', target);
  await page.mouse.down(); await page.waitForTimeout(110); await page.mouse.up();
  await page.waitForTimeout(400);
  // Then the human looks upfield: pointer to the middle of the screen.
  const keeper = r.taker;
  let shot = 0;
  for (let k = 0; k < 200; k++) {
    await page.mouse.move(box.x + box.width * (0.6 + 0.02 * (k % 2)), box.y + box.height * 0.45);
    const st = await page.evaluate((gk) => { const s = window.__derbyMatch; const b = s.ball; return { tick: s.tick, phase: s.phase, owner: b.owner, inHands: b.inHands, lastTouch: b.lastTouch, ballX: +b.pos.x.toFixed(1), ctl: s.controlled[0], setPiece: b.setPiece, ev: s.events.slice(-3).map((e) => e.kind + (e.restart ? ':' + e.restart : '')) }; }, keeper);
    if (k % 10 === 0) console.log(st);
    if (st.owner === keeper && st.inHands && st.phase === 'play') {
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/goalkick-repickup-${W}.png` });
      console.log('KEEPER PICKED UP HIS OWN GOAL KICK', st);
      shot = 1; break;
    }
    if (st.lastTouch !== keeper && st.lastTouch >= 0) { console.log('someone else touched it', st); break; }
    await page.waitForTimeout(60);
  }
  await browser.close();
})();
