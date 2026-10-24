// node cycles.cjs <renderer> <n> <halfSeconds> <tag>
// Home -> ranked match (played to full time with random mouse input) -> result -> Back to the club, n times.
// After each return to Home: forced GC, then heap / DOM nodes / listeners / WebGL contexts.
const fs = require('fs');
const { launch, openPage, metrics, helpers, startRankedClean, pitchBox } = require('./common.cjs');
const { replaySnapshot } = require('./snap.cjs');
(async () => {
  const [renderer = '3d', n = '5', half = '8', tag = 'cycles'] = process.argv.slice(2);
  const browser = await launch();
  const { page, cdp, problems, logs } = await openPage(browser, { renderer: renderer + (process.env.DEBUG3D ? '&debug3d' : ''), prefs: { halfSeconds: Number(half) } });
  const c = cdp();
  const rows = [];
  const snap = async (label) => {
    const m = await metrics(c, true);
    const extra = await page.evaluate(() => ({
      stored: (() => { try { return JSON.parse(localStorage.getItem('derbyday.replays.v1') || '[]').length; } catch { return -1; } })(),
      gl: window.__gl.length,
      glLive: window.__gl.filter((g) => !g.isContextLost()).length,
      canvases: document.querySelectorAll('canvas').length,
      styleEls: document.querySelectorAll('style').length,
      bodyKids: document.body.children.length,
      info: window.__derby3d ? { geo: window.__derby3d.gl.info.memory.geometries, tex: window.__derby3d.gl.info.memory.textures, progs: (window.__derby3d.gl.info.programs || []).length } : null,
    }));
    rows.push({ label, ...m, ...extra });
    console.log(JSON.stringify(rows.at(-1)));
  };
  await snap('home-0');
  for (let i = 1; i <= Number(n); i++) {
    await startRankedClean(page);
    const box = await pitchBox(page);
    let done = false;
    page.locator('.modal').waitFor({ timeout: 20 * 60 * 1000 }).then(() => { done = true; }).catch(() => {});
    let k = 0;
    let inMatch = null;
    while (!done) {
      k++;
      const x = box.x + box.width * (0.15 + 0.7 * Math.random());
      const y = box.y + box.height * (0.2 + 0.65 * Math.random());
      await page.mouse.move(x, y, { steps: 3 }).catch(() => {});
      if (k % 4 === 0) await page.mouse.click(x, y, { delay: 80 }).catch(() => {});
      await page.waitForTimeout(300);
      if (!inMatch && k === 6 && process.env.DEBUG3D) inMatch = await page.evaluate(() => window.__derby3d ? { geo: window.__derby3d.gl.info.memory.geometries, tex: window.__derby3d.gl.info.memory.textures, progs: (window.__derby3d.gl.info.programs || []).length, calls: window.__derby3d.gl.info.render.calls } : null).catch(() => null);
    }
    const endInfo = process.env.DEBUG3D ? await page.evaluate(() => ({ geo: window.__derby3d.gl.info.memory.geometries, tex: window.__derby3d.gl.info.memory.textures, progs: (window.__derby3d.gl.info.programs || []).length })).catch(() => null) : null;
    await page.locator(helpers.SEL.modalClose).click();
    await page.locator('.modal').waitFor({ state: 'detached' });
    await page.waitForTimeout(500);
    await snap(`home-${i}`);
    if (process.env.SNAPSHOT) { rows.at(-1).snap = await replaySnapshot(c); console.log('snapshot', JSON.stringify(rows.at(-1).snap)); }
    rows.at(-1).inMatch = inMatch;
    rows.at(-1).endInfo = endInfo;
  }
  const res = { tag, renderer, half, rows, problems, logs: logs.slice(0, 40), nlogs: logs.length };
  fs.writeFileSync(`/tmp/rt/perf/out/${tag}.json`, JSON.stringify(res, null, 1));
  console.log(JSON.stringify({ problems, logs: res.logs }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
