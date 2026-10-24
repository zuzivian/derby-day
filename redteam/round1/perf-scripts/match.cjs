// node match.cjs <renderer 2d|3d> <throttle> <halfSeconds|full> <tag> [w h]
const fs = require('fs');
const { launch, openPage, stats, metrics, helpers } = require('./common.cjs');
(async () => {
  const [renderer = '3d', thr = '4', half = 'full', tag = 'run', w = '1280', h = '800'] = process.argv.slice(2);
  const browser = await launch();
  const prefs = half === 'full' ? undefined : { halfSeconds: Number(half) };
  const { page, cdp, problems, logs } = await openPage(browser, { renderer: renderer + (process.env.DEBUG3D ? '&debug3d' : ''), throttle: Number(thr), prefs, width: +w, height: +h });
  const c = cdp();
  const m0 = await metrics(c, true);
  const t0 = Date.now();
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
  const info = await page.evaluate(() => ({ renderer: document.querySelector('#pitch').dataset.renderer, quality: document.querySelector('#pitch').dataset.quality, halfTicks: window.__derbyMatch.halfTicks, dpr: devicePixelRatio, cw: document.querySelector('#pitch').width, ch: document.querySelector('#pitch').height }));
  console.log('start', JSON.stringify(info));
  await page.evaluate(() => { window.__perf.on = true; });
  const box = await page.locator('#pitch').boundingBox();
  const samples = [];
  const tStart = Date.now();
  let lastSample = 0;
  let i = 0;
  let done = false;
  page.locator('.modal').waitFor({ timeout: 60 * 60 * 1000 }).then(() => { done = true; }).catch(() => {});
  while (!done) {
    i++;
    const x = box.x + box.width * (0.15 + 0.7 * Math.random());
    const y = box.y + box.height * (0.2 + 0.65 * Math.random());
    await page.mouse.move(x, y, { steps: 4 }).catch(() => {});
    if (i % 5 === 0) await page.mouse.click(x, y, { delay: 90 }).catch(() => {});
    if (i % 17 === 0) await page.mouse.click(x, y, { button: 'right', delay: 90 }).catch(() => {});
    await page.waitForTimeout(350);
    if (Date.now() - lastSample > Number(process.env.SAMPLE_MS || 20000)) {
      lastSample = Date.now();
      const st = await page.evaluate(() => { const s = window.__derbyMatch; const d = document.querySelector('#pitch')?.dataset || {}; return s ? { tick: s.tick, phase: s.phase, score: s.score.join('-'), fps: d.fps, cpuMs: d.cpuMs, calls: d.calls, tris: d.tris, events: s.events.length } : null; }).catch(() => null);
      const m = await metrics(c, !!process.env.GC).catch(() => null);
      samples.push({ wall: Math.round((Date.now() - tStart) / 1000), ...st, ...m });
      console.log(JSON.stringify(samples.at(-1)));
    }
  }
  const wall = (Date.now() - tStart) / 1000;
  const P = await page.evaluate(() => { const P = window.__perf; P.on = false; return { draw: P.draw, glr: P.glr, cb: P.cb, iv: P.iv, longtasks: P.longtasks, loafs: P.loafs, gl: window.__gl.length, glLost: window.__gl.filter((g) => g.isContextLost()).length }; });
  const m1 = await metrics(c, true);
  const loafScripts = {};
  for (const l of P.loafs) for (const s of l.scripts) { const k = s.inv; loafScripts[k] = (loafScripts[k] || 0) + s.d; }
  const res = {
    tag, renderer, thr, half, info, wall: +wall.toFixed(1),
    frameInterval: stats(P.iv), rafCallback: stats(P.cb), draw3d: stats(P.draw), glRender: stats(P.glr), loafRaf: stats(P.loafs.map((l) => l.raf)), loafRender: stats(P.loafs.map((l) => l.render)), loafPre: stats(P.loafs.map((l) => l.pre)),
    over33: P.iv.filter((v) => v > 33.4).length, over50: P.iv.filter((v) => v > 50).length, over100: P.iv.filter((v) => v > 100).length, over200: P.iv.filter((v) => v > 200).length,
    longtasks: { ...stats(P.longtasks), total: +P.longtasks.reduce((a, b) => a + b, 0).toFixed(0) },
    loafs: { ...stats(P.loafs.map((l) => l.d)), topInvokers: Object.entries(loafScripts).sort((a, b) => b[1] - a[1]).slice(0, 8) },
    gl: P.gl, glLost: P.glLost, before: m0, after: m1, samples, problems, logs: logs.slice(0, 50), nlogs: logs.length,
  };
  fs.writeFileSync(`/tmp/rt/perf/out/${tag}.json`, JSON.stringify(res, null, 1));
  console.log(JSON.stringify({ ...res, samples: undefined }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
