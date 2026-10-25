const { chromium } = require('playwright');
const { openApp, startRanked, SEL } = require('/tmp/rt/rules/repo/tests/e2e/lib/helpers.cjs');
const OUT = '/tmp/rt/rules/out/shots';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const W = Number(process.env.W || 1280), H = Number(process.env.H || 800);
  const t = { newPage: async (o) => { const ctx = await browser.newContext(o); await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); return ctx.newPage(); } };
  const page = await openApp(t, { width: W, height: H, prefs: { halfSeconds: 600 }, e2eHook: true, renderer: '3d' });
  await startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  // The home side was fouled, advantage is being played (as judgeFoul leaves it), then an away player wins the ball.
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    const me = s.players[s.controlled[0]];
    s.advantage = { team: 0, until: s.tick + 120, spot: { ...me.pos }, penalty: false };
    s.events.push({ kind: 'foul', tick: s.tick, minute: 1, second: 30, team: 1, player: 20, victim: me.i, spot: { ...me.pos }, severity: 'careless', penalty: false, advantage: true });
    s.events.push({ kind: 'advantage', tick: s.tick, minute: 1, second: 30, team: 0, player: me.i, spot: { ...me.pos } });
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/advantage-tag-${W}.png` });
  await page.evaluate(() => { const s = window.__derbyMatch; const opp = s.players.find((p) => p.team === 1 && p.role === 'MID'); s.ball.owner = opp.i; s.ball.pos = { ...opp.pos }; s.ball.inHands = false; });
  await page.waitForFunction(() => window.__derbyMatch.phase === 'restart', null, { timeout: 10000 });
  const ev = await page.evaluate(() => window.__derbyMatch.events.slice(-2).map((e) => `${e.kind}${e.restart ? ':' + e.restart : ''} ${e.reason || ''}`));
  console.log('events at callback', ev);
  for (const ms of [250, 1200]) {
    await page.waitForTimeout(ms === 250 ? 250 : 950);
    const ui = await page.evaluate(() => ({ banner: document.querySelector('#banner')?.hidden === false ? document.querySelector('#banner').innerText : null, tag: [...document.querySelectorAll('.hud-call, [class*="call"]')].filter((e) => !e.hidden && e.offsetParent).map((e) => e.innerText).join('|'), live: document.querySelector('[aria-live]')?.innerText }));
    console.log(ms, 'ms after callback:', ui);
    await page.screenshot({ path: `${OUT}/advantage-callback-${W}-${ms}.png` });
  }
  await browser.close();
})();
