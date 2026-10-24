// Replay viewer: open and close "Watch" on the Club tab 3 times; how many Renderer3D stay alive?
const { launch, openPage, metrics, helpers, startRankedClean } = require('./common.cjs');
(async () => {
  const browser = await launch();
  const { page, cdp } = await openPage(browser, { renderer: '3d&debug3d', prefs: { halfSeconds: 3 } });
  const c = cdp();
  await c.send('Runtime.enable');
  const count = async (expr) => {
    const { result } = await c.send('Runtime.evaluate', { expression: expr });
    const { objects } = await c.send('Runtime.queryObjects', { prototypeObjectId: result.objectId, objectGroup: 'leak' });
    const { result: len } = await c.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function(){return this.length}', returnByValue: true });
    await c.send('Runtime.releaseObjectGroup', { objectGroup: 'leak' });
    return len.value;
  };
  await startRankedClean(page);
  await page.waitForFunction(() => window.__derby3d, null, { timeout: 30000 });
  await page.evaluate(() => { window.__protoR3D = Object.getPrototypeOf(window.__derby3d); });
  await page.locator('.modal').waitFor({ timeout: 5 * 60 * 1000 });
  await page.locator(helpers.SEL.modalClose).click();
  await page.locator('.modal').waitFor({ state: 'detached' });
  await page.evaluate(() => { delete window.__derby3d; });
  await metrics(c, true);
  console.log('after match', await count('window.__protoR3D'));
  await helpers.goTab(page, 'club');
  for (let i = 1; i <= 3; i++) {
    await page.locator('[data-replay="watch"]').first().click();
    await page.locator('[data-rp="close"]').waitFor();
    await page.waitForTimeout(2500);
    await page.locator('[data-rp="close"]').click();
    await page.locator('[data-rp="close"]').waitFor({ state: 'detached' });
    await page.evaluate(() => { delete window.__derby3d; });
    const m = await metrics(c, true);
    console.log(JSON.stringify({ viewerOpens: i, Renderer3D: await count('window.__protoR3D'), heapMB: m.heapMB, nodes: m.nodes, listeners: m.listeners }));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
