// Does the first card of a match compile a new shader mid-match? node cardhitch.cjs
const { launch, openPage, helpers } = require('./common.cjs');
(async () => {
  const browser = await launch();
  const { page } = await openPage(browser, { renderer: '3d&debug3d', prefs: { halfSeconds: 600 }, throttle: Number(process.argv[2] || 1) });
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play' && window.__derby3d, null, { timeout: 60000 });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(async () => {
    const R = window.__derby3d;
    const s = window.__derbyMatch;
    const P = window.__perf;
    const frames = (n) => new Promise((res) => { const out = []; let last = performance.now(); const f = () => { const now = performance.now(); out.push(+(now - last).toFixed(1)); last = now; if (out.length < n) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); });
    P.on = true; P.cb = [];
    const base = await frames(20);
    const baseCb = P.cb.slice(); P.cb = [];
    const progs0 = R.gl.info.programs.length;
    const p = s.players.find((q) => q.team === 1 && q.role !== 'GK');
    s.events.push({ kind: 'card', color: 'yellow', player: p.i, team: 1, tick: s.tick, minute: 1, name: p.name });
    const after = await frames(10);
    const afterCb = P.cb.slice();
    P.on = false;
    return { progs0, progs1: R.gl.info.programs.length, newProg: R.gl.info.programs.slice(progs0).map((x) => x.name || x.cacheKey?.slice(0, 80)), baseIntervals: base, baseCb: baseCb.map((x) => +x.toFixed(1)), afterIntervals: after, afterCb: afterCb.map((x) => +x.toFixed(1)) };
  });
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
