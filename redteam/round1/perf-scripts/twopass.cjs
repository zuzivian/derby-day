// How many material.needsUpdate bumps (each one a three.js getProgram call) happen per frame, and from which materials?
const { launch, openPage, helpers } = require('./common.cjs');
(async () => {
  const browser = await launch();
  const { page } = await openPage(browser, { renderer: '3d&debug3d', prefs: { halfSeconds: 600 } });
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play' && window.__derby3d, null, { timeout: 60000 });
  const box = await page.locator('#pitch').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => new Promise((res) => {
    const R = window.__derby3d;
    const mats = new Map();
    const collect = () => { R.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) if (!mats.has(m)) mats.set(m, { v0: m.version, who: `${o.type}:${m.type}${m.transparent ? ' transparent' : ''}${m.side === 2 ? ' DoubleSide' : ''}`, users: 0 }); }); };
    collect();
    R.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) mats.get(m).users += o.visible ? 1 : 0; });
    const calls0 = [];
    let frames = 0;
    const f = () => {
      frames++; calls0.push(R.gl.info.render.calls);
      if (frames < 60) requestAnimationFrame(f);
      else {
        let bumps = 0; const by = {};
        for (const [m, e] of mats) { const d = m.version - e.v0; if (d) { bumps += d; by[e.who] = (by[e.who] || 0) + d; } }
        res({ frames, bumpsPerFrame: +(bumps / frames).toFixed(1), byMaterialPerFrame: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +(v / frames).toFixed(1)])), drawCalls: calls0.slice(-5) });
      }
    };
    requestAnimationFrame(f);
  }));
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
