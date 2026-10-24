// Which materials have more than one program (three.js then re-derives program parameters on every switch)?
const { launch, openPage, helpers } = require('./common.cjs');
(async () => {
  const browser = await launch();
  const { page } = await openPage(browser, { renderer: '3d&debug3d', prefs: { halfSeconds: 600 } });
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play' && window.__derby3d, null, { timeout: 60000 });
  await page.waitForTimeout(8000);
  const r = await page.evaluate(() => {
    const R = window.__derby3d;
    const mats = new Map();
    let objects = 0, meshes = 0;
    R.scene.traverse((o) => {
      objects++;
      if (!o.material) return;
      meshes++;
      for (const m of [].concat(o.material)) {
        const e = mats.get(m) || { type: m.type, name: m.name, users: {} };
        const k = `${o.type}${o.visible ? '' : '(hidden)'}`;
        e.users[k] = (e.users[k] || 0) + 1;
        mats.set(m, e);
      }
    });
    const multi = [];
    for (const [m, e] of mats) {
      const p = R.gl.properties.get(m);
      const n = p && p.programs ? p.programs.size : 0;
      if (n > 1) { const ks = [...p.programs.keys()]; const a = ks[0].split(","), b = ks[1].split(","); const diff = a.map((x, i) => x !== b[i] ? i + ":" + x + "->" + b[i] : null).filter(Boolean); multi.push({ ...e, programs: n, diff, len: a.length, tail: a.slice(45).join(","), tailB: b.slice(45).join(","), cur: p.currentProgram ? ks.indexOf([...p.programs.entries()].find(([k, v]) => v === p.currentProgram)[0]) : -1, depthTest: m.depthTest, transparent: m.transparent, side: m.side }); }
    }
    return { objects, meshes, materials: mats.size, programs: R.gl.info.programs.length, multi, calls: R.gl.info.render.calls };
  });
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
