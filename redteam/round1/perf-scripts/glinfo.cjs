// renderer.info.memory (geometries, textures) and programs over a minute of play with input.
const { launch, openPage, helpers } = require('./common.cjs');
(async () => {
  const browser = await launch();
  const { page } = await openPage(browser, { renderer: '3d&debug3d', prefs: { halfSeconds: 600 } });
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derby3d && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
  const box = await page.locator('#pitch').boundingBox();
  const info = () => page.evaluate(() => { const g = window.__derby3d.gl.info; return { tick: window.__derbyMatch.tick, geo: g.memory.geometries, tex: g.memory.textures, progs: g.programs.length, calls: g.render.calls, cards: window.__derbyMatch.cards.length }; });
  const out = [await info()];
  const end = Date.now() + 75000;
  let k = 0;
  while (Date.now() < end) {
    k++;
    const x = box.x + box.width * (0.15 + 0.7 * Math.random());
    const y = box.y + box.height * (0.2 + 0.65 * Math.random());
    await page.mouse.move(x, y, { steps: 3 });
    if (k % 4 === 0) await page.mouse.click(x, y, { delay: 80 });
    await page.waitForTimeout(250);
    if (k % 60 === 0) out.push(await info());
  }
  out.push(await info());
  console.log(JSON.stringify(out));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
