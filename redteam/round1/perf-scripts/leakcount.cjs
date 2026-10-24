// After each match, back on Home: how many Renderer3D / WebGLRenderer / canvas objects are still alive?
// node leakcount.cjs <renderer> <n> [halfSeconds]
const { launch, openPage, metrics, helpers, startRankedClean } = require('./common.cjs');
(async () => {
  const [renderer = '3d', n = '3', half = '4'] = process.argv.slice(2);
  const browser = await launch();
  const { page, cdp } = await openPage(browser, { renderer: renderer === '3d' ? '3d&debug3d' : renderer, prefs: { halfSeconds: Number(half) } });
  const c = cdp();
  await c.send('Runtime.enable');
  const count = async (expr) => {
    const { result } = await c.send('Runtime.evaluate', { expression: expr });
    if (!result.objectId) return null;
    const { objects } = await c.send('Runtime.queryObjects', { prototypeObjectId: result.objectId, objectGroup: 'leak' });
    const { result: len } = await c.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function(){return this.length}', returnByValue: true });
    await c.send('Runtime.releaseObjectGroup', { objectGroup: 'leak' });
    return len.value;
  };
  for (let i = 1; i <= Number(n); i++) {
    await startRankedClean(page);
    if (i === 1 && renderer === '3d') {
      await page.waitForFunction(() => window.__derby3d, null, { timeout: 30000 });
      await page.evaluate(() => { window.__protoR3D = Object.getPrototypeOf(window.__derby3d); window.__protoGL = Object.getPrototypeOf(window.__derby3d.gl); window.__protoScene = Object.getPrototypeOf(window.__derby3d.scene); });
    }
    if (process.env.FIX) { await page.waitForFunction(() => window.__derby3d && window.__derby3d.gl.properties.get(window.__derby3d.ball.material).uniforms, null, { timeout: 30000 }); await page.evaluate(() => { window.__lut = window.__derby3d.gl.properties.get(window.__derby3d.ball.material).uniforms.dfgLUT.value; }); }
    await page.locator('.modal').waitFor({ timeout: 10 * 60 * 1000 });
    await page.locator(helpers.SEL.modalClose).click();
    await page.locator('.modal').waitFor({ state: 'detached' });
    if (process.env.FIX) await page.evaluate(() => { const sp = window.__derby3d.aim && window.__derby3d.aim.markers && window.__derby3d.aim.markers[0]; window.__fixed = !!sp; if (sp) sp.geometry.dispose(); if (window.__lut) window.__lut.dispose(); });
    await page.evaluate(() => { delete window.__derby3d; delete window.__derbyMatch; });
    await page.waitForTimeout(300);
    const m = await metrics(c, true);
    const r3d = renderer === '3d' ? await count('window.__protoR3D') : null;
    const wgl = renderer === '3d' ? await count('window.__protoGL') : null;
    const scenes = renderer === '3d' ? await count('window.__protoScene') : null;
    const canv = await count('HTMLCanvasElement.prototype');
    const sections = await count('HTMLElement.prototype');
    console.log(JSON.stringify({ match: i, heapMB: m.heapMB, nodes: m.nodes, listeners: m.listeners, Renderer3D: r3d, WebGLRenderer: wgl, Scene: scenes, canvases: canv, htmlElements: sections }));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
