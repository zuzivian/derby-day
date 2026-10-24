// Performance and lifecycle of the match screen: matches played back to back in one tab must not
// pile up memory (red-team round 1, perf). Measured over CDP after forced garbage collection.
//
// Harness trap: page.waitForSelector returns an ElementHandle that is never released, and it pins
// the canvas it found, which looks exactly like a leak in the game. Use locator.waitFor() here.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab } = require('./lib/helpers.cjs');

/** CDP helpers on one page: forced GC, Performance metrics, live instance counts. */
async function probe(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  async function count(proto, fn = 'function(){return this.length}') {
    const { result } = await cdp.send('Runtime.evaluate', { expression: `${proto}.prototype`, objectGroup: 'perf' });
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: result.objectId, objectGroup: 'perf' });
    const r = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: fn, returnByValue: true, objectGroup: 'perf' });
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'perf' });
    return r.result.value;
  }
  return {
    cdp,
    count,
    async measure() {
      await page.waitForTimeout(500);
      for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
      return {
        heapMB: m.JSHeapUsedSize / 1e6,
        nodes: m.Nodes,
        listeners: m.JSEventListeners,
        detachedCanvases: await count('HTMLCanvasElement', 'function(){return this.filter((c) => !c.isConnected).length}'),
        glContexts: await count('WebGL2RenderingContext'),
        resizeObservers: await count('ResizeObserver'),
      };
    },
  };
}

/** One short ranked match from Home to the result dialog and back. */
async function playOne(page) {
  await goTab(page, SEL.homeScreen);
  await page.locator(SEL.playRanked).click();
  await page.locator(SEL.pitch).waitFor();
  const renderer = await page.locator(SEL.pitch).getAttribute('data-renderer');
  await page.locator(SEL.modal).waitFor({ timeout: 120_000 });
  await page.locator(SEL.modalClose).click();
  await page.locator(SEL.modal).waitFor({ state: 'detached' });
  return renderer;
}

test(
  'Perf: four 3D matches in a row leave no renderer, canvas, DOM or listeners behind',
  async (t) => {
    const page = await openApp(t, { prefs: { halfSeconds: 1 }, renderer: '3d' });
    const p = await probe(page);
    const home0 = await p.measure();
    const first = await playOne(page);
    if (first !== '3d') return; // no WebGL2 here: the 2D view has nothing to leak
    // Match 1 pays three.js's one-time set-up (shader chunks, module state): the baseline is after it.
    const base = await p.measure();
    const rows = [base];
    for (let i = 0; i < 3; i++) {
      await playOne(page);
      rows.push(await p.measure());
    }
    const last = rows[rows.length - 1];
    const show = rows.map((r) => `${r.heapMB.toFixed(2)} MB/${r.nodes} nodes/${r.listeners} listeners/${r.detachedCanvases} canvases/${r.glContexts} gl`).join(' → ');
    console.log(`      home before ${home0.heapMB.toFixed(2)} MB; after each match: ${show}`);
    for (const [i, r] of rows.entries()) {
      expect(r.detachedCanvases, `match ${i + 1}: no detached canvas survives (the pitch and its ~35 texture canvases)`).toBeLessThanOrEqual(1);
      expect(r.glContexts, `match ${i + 1}: no WebGL context survives`).toBe(0);
      expect(r.resizeObservers, `match ${i + 1}: no ResizeObserver survives`).toBe(0);
    }
    expect(last.listeners - base.listeners, 'listeners stay flat').toBeLessThanOrEqual(2);
    // Home itself gains a few nodes a match (news, recent results), in 2D as much as in 3D; a leaked
    // match holds ~280.
    expect((last.nodes - base.nodes) / 3, 'DOM nodes per match').toBeLessThan(50);
    // A leaked match is ~3 MB of heap; three more matches must add well under one.
    expect(last.heapMB - base.heapMB, 'JS heap stays flat').toBeLessThan(1.2);
  },
  { timeoutMs: 240_000 },
);

test(
  'Perf: opening and closing the 3D replay viewer three times leaves nothing behind',
  async (t) => {
    const page = await openApp(t, { prefs: { halfSeconds: 1 }, renderer: '3d' });
    const p = await probe(page);
    if ((await playOne(page)) !== '3d') return;
    await goTab(page, SEL.clubScreen);
    const open = async () => {
      await page.locator('.rp-row [data-replay="watch"]').first().click();
      await page.locator('[data-rp="close"]').waitFor();
      await page.waitForTimeout(1500);
      await page.locator('[data-rp="close"]').click();
      await page.locator('[data-rp="close"]').waitFor({ state: 'detached' });
    };
    await open(); // the first open pays three.js's one-time set-up
    const base = await p.measure();
    for (let i = 0; i < 3; i++) await open();
    const last = await p.measure();
    console.log(`      after the first open ${base.heapMB.toFixed(2)} MB/${base.nodes} nodes/${base.listeners} listeners; after three more ${last.heapMB.toFixed(2)} MB/${last.nodes}/${last.listeners}, ${last.detachedCanvases} canvases, ${last.glContexts} gl`);
    expect(last.detachedCanvases, 'no detached canvas survives').toBeLessThanOrEqual(1);
    expect(last.glContexts, 'no WebGL context survives').toBe(0);
    expect(last.resizeObservers, 'no ResizeObserver survives').toBe(0);
    expect(last.listeners - base.listeners, 'listeners stay flat').toBeLessThanOrEqual(1);
    expect(last.nodes - base.nodes, 'DOM nodes stay flat (a leaked viewer is ~76)').toBeLessThan(30);
    expect(last.heapMB - base.heapMB, 'JS heap stays flat').toBeLessThan(0.8);
  },
  { timeoutMs: 180_000 },
);
