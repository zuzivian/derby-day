// Performance and lifecycle of the match screen: matches played back to back in one tab must not
// pile up memory (red-team round 1, perf). Measured over CDP after forced garbage collection.
//
// Harness trap: page.waitForSelector returns an ElementHandle that is never released, and it pins
// the canvas it found, which looks exactly like a leak in the game. Use locator.waitFor() here.

const { test, expect } = require('./lib/harness.cjs');
const { APP_URL, SEL, openApp, goTab, skipOnboarding } = require('./lib/helpers.cjs');

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

for (const quality of ['low', 'high']) test(
  `Perf: prepare() compiles every shader a ${quality}-quality match uses, so a card, a goal and its replay compile none mid-match`,
  async (t) => {
    const page = await openApp(t, { prefs: { halfSeconds: 600 }, renderer: '3d', e2eHook: true, query: `debug3d&quality=${quality}` });
    await goTab(page, SEL.homeScreen);
    await page.locator(SEL.playRanked).click();
    await page.locator(SEL.pitch).waitFor();
    if ((await page.locator(SEL.pitch).getAttribute('data-renderer')) !== '3d') return;
    await page.waitForFunction(() => window.__derby3d && window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60_000 });
    // Every program compiled from here on, sampled each frame (a program no longer used can be released again).
    const before = await page.evaluate(() => {
      const gl = window.__derby3d.gl;
      const seen = new Set(gl.info.programs.map((p) => p.cacheKey));
      window.__newPrograms = [];
      const watch = () => {
        for (const p of gl.info.programs) if (!seen.has(p.cacheKey)) seen.add(p.cacheKey), window.__newPrograms.push(`${p.name} ${p.cacheKey.slice(0, 60)}`);
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
      return gl.info.programs.length;
    });
    // A yellow card over a player (a sprite with no texture), shown for a few seconds.
    await page.evaluate(() => {
      const s = window.__derbyMatch;
      const p = s.players.find((q) => q.team === 1 && q.role !== 'GK');
      s.events.push({ kind: 'card', color: 'yellow', player: p.i, team: 1, tick: s.tick, minute: 1, name: p.name });
    });
    await page.waitForTimeout(1500);
    // A goal: net ripple, celebration, then the instant replay with its cameras. Staged in the page, on an
    // animation frame when play is live and no replay holds the match, so a goal the AI scores first (and
    // its kick-off and replay) can't swallow it; then wait for our goal by count, not for the score to read 1-0.
    const goals = await page.evaluate(
      () =>
        new Promise((res) => {
          const tryStage = () => {
            const s = window.__derbyMatch;
            if (s.phase !== 'play' || document.querySelector('#pitch').dataset.replay || s.ball.inHands) return requestAnimationFrame(tryStage);
            const n = s.goals.length;
            const b = s.ball;
            b.owner = -1;
            for (const k of s.players) if (k.team === 1 && k.role === 'GK') k.pos = { x: 100, y: 40 };
            b.pos = { x: 95, y: 31.5 };
            b.vel = { x: 26, y: 0 };
            b.z = 0.3;
            b.vz = 0.5;
            b.lastTouch = s.controlled[0];
            s.stats[0].shots++;
            res(n);
          };
          tryStage();
        }),
    );
    await page.waitForFunction((n) => window.__derbyMatch.goals.slice(n).some((g) => g.team === 0), goals, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('#pitch').dataset.replay === 'goal', null, { timeout: 30_000 });
    await page.waitForTimeout(2000);
    const added = await page.evaluate(() => window.__newPrograms);
    expect(added.join(' | ') || 'none', `no shader compiled after prepare() (${before} programs)`).toBe('none');
  },
  { timeoutMs: 150_000 },
);

for (const renderer of ['3d', '2d']) test(
  `Perf: in open play the ${renderer} match screen leaves the score bar and the canvas attributes alone (no per-frame DOM writes)`,
  async (t) => {
    const page = await openApp(t, { prefs: { halfSeconds: 600 }, renderer, e2eHook: true });
    await goTab(page, SEL.homeScreen);
    await page.locator(SEL.playRanked).click();
    await page.locator(SEL.pitch).waitFor();
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60_000 });
    await page.waitForTimeout(1000);
    // A write is redundant when it sets what was already there: those are what cost a style and layout
    // pass for nothing. Real changes (a goal, the minute ticking over, a camera cut) are fine however
    // many happen, so this does not depend on how much play a slow machine packs into 120 frames.
    const r = await page.evaluate(
      () =>
        new Promise((res) => {
          const root = document.querySelector('.match');
          const watched = ['sb-h', 'sb-a', 'sb-min', 'sb-phase'];
          const writes = {};
          const redundant = {};
          const count = (k, same) => {
            writes[k] = (writes[k] || 0) + 1;
            if (same) redundant[k] = (redundant[k] || 0) + 1;
          };
          const camera = [];
          const ob = new MutationObserver((list) => {
            for (const m of list) {
              const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
              if (m.type === 'attributes' && el?.id === 'pitch' && m.attributeName === 'data-camera') camera.push(m.oldValue);
              else if (m.type === 'childList' && watched.includes(el?.id)) {
                const before = [...m.removedNodes].map((x) => x.textContent).join('');
                const after = [...m.addedNodes].map((x) => x.textContent).join('');
                count(`#${el.id}`, before === after);
              }
            }
          });
          ob.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
          let frames = 0;
          const t0 = window.__derbyMatch.tick;
          const f = () => {
            if (++frames < 120) return requestAnimationFrame(f);
            ob.takeRecords();
            ob.disconnect();
            // Record i's old value is what write i-1 set; the last write set the current value.
            const values = [...camera.slice(1), document.querySelector('#pitch').dataset.camera];
            camera.forEach((old, i) => count('#pitch[data-camera]', old === values[i]));
            res({ writes, redundant, ticks: window.__derbyMatch.tick - t0 });
          };
          requestAnimationFrame(f);
        }),
    );
    console.log(`      120 frames (${r.ticks} ticks): writes ${JSON.stringify(r.writes)}, redundant ${JSON.stringify(r.redundant)}`);
    for (const k of ['#sb-h', '#sb-a', '#sb-min', '#sb-phase', '#pitch[data-camera]']) expect(r.redundant[k] || 0, `${k} is never rewritten with the value it already has`).toBe(0);
  },
  { timeoutMs: 120_000 },
);

/** Before boot: keep every AudioContext the page makes, and let a test fake a hidden tab. */
function audioAndVisibilityHooks() {
  window.__ac = [];
  const AC = window.AudioContext;
  if (AC) window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__ac.push(this); } };
  window.__setHidden = (hidden) => {
    if (hidden) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    } else {
      delete document.hidden;
      delete document.visibilityState;
    }
    document.dispatchEvent(new Event('visibilitychange'));
  };
}

test(
  'Perf: match sound stops while paused, with the tab hidden and after the match, and plays again on resume',
  async (t) => {
    const page = await openApp(t, { prefs: { halfSeconds: 600 }, e2eHook: true, init: audioAndVisibilityHooks });
    await goTab(page, SEL.homeScreen);
    await page.locator(SEL.playRanked).click();
    await page.locator(SEL.pitch).waitFor();
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60_000 });
    const box = await page.locator(SEL.pitch).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // a gesture, so the context may run
    const state = () => page.evaluate(() => window.__ac.map((c) => c.state).join(','));
    const waitState = (want) => page.waitForFunction((w) => window.__ac.length > 0 && window.__ac.every((c) => c.state === w), want, { timeout: 5000 }).then(() => true, () => false);
    if (!(await waitState('running'))) return; // no audio output in this browser
    await page.keyboard.press('Escape');
    await page.locator(SEL.pause).waitFor({ state: 'visible' });
    expect(await waitState('suspended'), `paused: the context is suspended (${await state()})`).toBe(true);
    await page.mouse.move(10, 10);
    await page.mouse.down(); // a stray click on the pause screen does not wake it
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await state(), 'still suspended after a click while paused').toBe('suspended');
    await page.locator(SEL.resume).click();
    expect(await waitState('running'), 'resumed: sound again').toBe(true);
    await page.evaluate(() => window.__setHidden(true));
    expect(await waitState('suspended'), 'tab hidden: suspended').toBe(true);
    await page.evaluate(() => window.__setHidden(false));
    await page.locator(SEL.resume).click();
    expect(await waitState('running'), 'back and resumed').toBe(true);
    await page.keyboard.press('Escape');
    await page.locator(SEL.forfeit).click();
    await page.locator(SEL.modal).waitFor();
    expect(await waitState('suspended'), 'after the match: suspended once the crowd fades').toBe(true);
  },
  { timeoutMs: 120_000 },
);

for (const [renderer, query] of [['3d', 'quality=high&governor=off'], ['2d', '']]) test(
  `Perf: the ${renderer} pitch's drawing buffer follows a devicePixelRatio change mid-match (new screen, browser zoom)`,
  async (t) => {
    const page = await openApp(t, { prefs: { halfSeconds: 600 }, renderer, e2eHook: true, query: query || undefined });
    await goTab(page, SEL.homeScreen);
    await page.locator(SEL.playRanked).click();
    await page.locator(SEL.pitch).waitFor();
    if ((await page.locator(SEL.pitch).getAttribute('data-renderer')) !== renderer) return;
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60_000 });
    const buf = () => page.evaluate(() => { const c = document.querySelector('#pitch'); return { w: c.width, css: c.getBoundingClientRect().width, dpr: devicePixelRatio }; });
    const one = await buf();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
    await page.waitForFunction(() => devicePixelRatio === 2);
    await page.waitForTimeout(1200);
    const two = await buf();
    expect(two.css, 'same CSS size').toBe(one.css);
    expect(two.w / one.w, `buffer ${one.w} → ${two.w} px doubles with the ratio`).toBeGreaterThan(1.9);
  },
  { timeoutMs: 120_000 },
);

/** Before boot: keep the WEBGL_lose_context extension of the pitch's context, so a test can lose and restore it. */
function loseContextHook() {
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const c = gc.call(this, type, ...rest);
    if (c && type === 'webgl2' && this.id === 'pitch') window.__lose = c.getExtension('WEBGL_lose_context');
    return c;
  };
}

async function startLongMatch(t, opts) {
  const page = await openApp(t, { prefs: { halfSeconds: 600 }, renderer: '3d', e2eHook: true, init: loseContextHook, query: 'debug3d', ...opts });
  await goTab(page, SEL.homeScreen);
  await page.locator(SEL.playRanked).click();
  await page.locator(SEL.pitch).waitFor();
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60_000 });
  return page;
}

test(
  'Perf: a lost WebGL context holds the match under "Restoring graphics…" and play resumes when it is restored',
  async (t) => {
    const page = await startLongMatch(t);
    if ((await page.locator(SEL.pitch).getAttribute('data-renderer')) !== '3d' || !(await page.evaluate(() => !!window.__lose))) return;
    await page.evaluate(() => window.__lose.loseContext());
    await page.locator('.gfx-note').waitFor({ state: 'visible', timeout: 3000 });
    expect(await page.locator('.gfx-note').innerText(), 'the note').toMatch(/restoring graphics/i);
    const held = await page.evaluate(() => window.__derbyMatch.tick);
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => window.__derbyMatch.tick), 'the match is held while the pitch cannot be drawn').toBe(held);
    await page.evaluate(() => window.__lose.restoreContext());
    await page.locator('.gfx-note').waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.__derbyMatch.tick), 'play resumes').toBeGreaterThan(held);
    expect(await page.locator(SEL.pitch).getAttribute('data-renderer'), 'still the 3D view').toBe('3d');
    // The renderer draws again: the context is back, and its once-a-second frame stats (written only by a draw
    // that ran, never while the context is lost) tick over. (Reading the WebGL pixels back is timing-dependent.)
    expect(await page.evaluate(() => document.querySelector('#pitch').getContext('webgl2').isContextLost()), 'the context is back').toBe(false);
    const drawing = await page.evaluate(
      () =>
        new Promise((res) => {
          const c = document.querySelector('#pitch');
          const ob = new MutationObserver(() => (ob.disconnect(), res(true)));
          ob.observe(c, { attributes: true, attributeFilter: ['data-fps', 'data-calls'] });
          setTimeout(() => (ob.disconnect(), res(false)), 5000);
        }),
    );
    expect(drawing, 'the renderer draws again').toBe(true);
    // And the frame is a picture, not blank: sample the drawing buffer right after three's render() (the
    // buffer is cleared once the frame is presented, so reading it any later is timing-dependent).
    const green = await page.evaluate(
      () =>
        new Promise((res) => {
          const gl3 = window.__derby3d.gl;
          const render = gl3.render;
          gl3.render = function (...a) {
            render.apply(this, a);
            gl3.render = render;
            const gl = gl3.getContext();
            const w = 48;
            const h = 24;
            const px = new Uint8Array(w * h * 4);
            // Lower middle of the frame (GL rows count from the bottom): pitch, whatever the camera does.
            gl.readPixels(Math.floor(gl.drawingBufferWidth / 2 - w / 2), Math.floor(gl.drawingBufferHeight * 0.3), w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let n = 0;
            for (let i = 0; i < px.length; i += 4) if (px[i + 1] > px[i] + 10 && px[i + 1] > px[i + 2] + 10) n++;
            res(n / (w * h));
          };
        }),
    );
    expect(green, 'the restored frame shows the pitch (share of green pixels in a sample)').toBeGreaterThan(0.5);
  },
  { timeoutMs: 120_000 },
);

test(
  'Perf: a WebGL context that never comes back: the match carries on in 2D from the same state and finishes with its result',
  async (t) => {
    const page = await startLongMatch(t, { prefs: { halfSeconds: 4 } });
    if ((await page.locator(SEL.pitch).getAttribute('data-renderer')) !== '3d' || !(await page.evaluate(() => !!window.__lose))) return;
    const before = await page.evaluate(() => { const s = window.__derbyMatch; s.score = [2, 1]; return s.tick; });
    await page.evaluate(() => window.__lose.loseContext());
    await page.locator('.gfx-note').waitFor({ state: 'visible', timeout: 3000 });
    await page.waitForFunction(() => document.querySelector('#pitch').dataset.renderer === '2d', null, { timeout: 8000 });
    expect(await page.locator(SEL.pitch).getAttribute('data-fallback'), 'marked as a fallback').toBe('context-lost');
    expect(await page.locator('.gfx-note').isVisible(), 'the note is gone').toBe(false);
    expect(await page.evaluate(() => window.__derbyMatch.tick), 'the same match, not a new one').toBeGreaterThanOrEqual(before);
    await page.locator(SEL.modal).waitFor({ timeout: 60_000 });
    expect(await page.locator(SEL.modal).innerText(), 'the result keeps the score').toMatch(/2\s*[–-]\s*1/);
  },
  { timeoutMs: 120_000 },
);

test(
  'Perf: closing the tab mid-match stops the loop and gives the WebGL context back; a back-forward cache hide does not',
  async (t) => {
    const page = await startLongMatch(t);
    if ((await page.locator(SEL.pitch).getAttribute('data-renderer')) !== '3d' || !(await page.evaluate(() => !!window.__lose))) return;
    const hide = (persisted) => page.evaluate((persisted) => dispatchEvent(new PageTransitionEvent('pagehide', { persisted })), persisted);
    const tick = () => page.evaluate(() => window.__derbyMatch.tick);
    // Parked in the back-forward cache: it may come back to this match, so it keeps it.
    await hide(true);
    const t0 = await tick();
    await page.waitForFunction((t0) => window.__derbyMatch.tick > t0 + 30, t0, { timeout: 15_000 });
    expect(await page.locator(SEL.pitch).getAttribute('data-renderer'), 'still drawing in 3D').toBe('3d');
    // Going away for good: the context is lost at once, no 2D fallback starts, and the sim stops.
    await hide(false);
    expect(await page.evaluate(() => document.querySelector('#pitch').getContext('webgl2').isContextLost()), 'context lost').toBe(true);
    const t1 = await tick();
    await page.waitForTimeout(1500);
    expect(await tick(), 'the loop stopped').toBe(t1);
    expect(await page.evaluate(() => document.querySelector('#pitch').dataset.renderer ?? null), 'no 2D fallback took over').toBe(null);
  },
  { timeoutMs: 120_000 },
);

test(
  'Perf: on a slow renderer (SwiftShader) the quality governor steps the 3D view down, one notch at a time',
  async (t) => {
    const page = await openApp(t, { prefs: { halfSeconds: 600 }, renderer: '3d', e2eHook: true });
    await goTab(page, SEL.homeScreen);
    await page.locator(SEL.playRanked).click();
    await page.locator(SEL.pitch).waitFor();
    if ((await page.locator(SEL.pitch).getAttribute('data-renderer')) !== '3d') return;
    // Record each level as it changes: one notch at a time, never back up. Watch from the start: the
    // kick-off is a kick (Law 8) and can wait five seconds for the CPU, long enough for a first step.
    const w0 = await page.evaluate(() => {
      const c = document.querySelector('#pitch');
      window.__levels = [];
      new MutationObserver(() => window.__levels.push(Number(c.dataset.governor))).observe(c, { attributes: true, attributeFilter: ['data-governor'] });
      return c.width;
    });
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60_000 });
    const stepped = await page.waitForFunction(() => Number(document.querySelector('#pitch').dataset.governor || 0) >= 1, null, { timeout: 30_000 }).then(() => true, () => false);
    if (!stepped) {
      // A fast enough machine (a real GPU) never needs to step down.
      console.log('      the governor did not step: this machine renders within budget');
      return;
    }
    await page.waitForTimeout(8000);
    const levels = await page.evaluate(() => window.__levels);
    expect(levels.every((l, i) => l === i + 1), `levels go 1, 2, 3… one at a time (${levels.join(', ')})`).toBe(true);
    const w1 = await page.evaluate(() => document.querySelector('#pitch').width);
    expect(w1, `the drawing buffer is smaller (${w0} → ${w1} px)`).toBeLessThan(w0);
  },
  { timeoutMs: 120_000 },
);

test(
  'Perf: a lost WebGL context in a linked (lockstep) match shows the note while play goes on, then carries on in 2D, in sync',
  async (t) => {
    const host = await openApp(t, { prefs: { halfSeconds: 60, controls: 'mouse' }, renderer: '3d', init: loseContextHook });
    // The guest draws in 2D: two software-rendered 3D tabs starve each other (see lockstep.e2e.cjs).
    const guest = await host.context().newPage();
    guest.setDefaultTimeout(20_000);
    await guest.goto(`${APP_URL.split('?')[0]}?renderer=2d`);
    await guest.locator('#guard-guest').click();
    await guest.waitForSelector(`${SEL.app} *`);
    await skipOnboarding(guest);
    await goTab(host, SEL.homeScreen);
    await host.locator(SEL.playLink).click();
    await host.locator(SEL.linkHost).click();
    const code = (await host.locator(SEL.linkCode).innerText()).trim();
    await goTab(guest, SEL.homeScreen);
    await guest.locator(SEL.playLink).click();
    await guest.locator(SEL.linkCodeInput).fill(code);
    await guest.locator(SEL.linkJoin).click();
    await host.locator(SEL.netMatch).waitFor();
    await guest.locator(SEL.netMatch).waitFor();
    if ((await host.locator(SEL.pitch).getAttribute('data-renderer')) !== '3d' || !(await host.evaluate(() => !!window.__lose))) return;
    const tickOf = (p) => p.evaluate((sel) => Number(document.querySelector(sel)?.dataset.tick || 0), SEL.netMatch);
    await host.waitForFunction((sel) => Number(document.querySelector(sel)?.dataset.tick || 0) > 30, SEL.netMatch, { timeout: 30_000 });
    await host.evaluate(() => window.__lose.loseContext());
    await host.locator('.gfx-note').waitFor({ state: 'visible', timeout: 3000 });
    const t0 = await tickOf(host);
    await host.waitForTimeout(1200);
    expect(await tickOf(host), 'the match goes on under the note (there is no pause online)').toBeGreaterThan(t0);
    await host.waitForFunction(() => document.querySelector('#pitch').dataset.renderer === '2d', null, { timeout: 8000 });
    expect(await host.locator(SEL.pitch).getAttribute('data-fallback'), 'marked as a fallback').toBe('context-lost');
    expect(await host.locator('.gfx-note').isVisible(), 'the note is gone').toBe(false);
    const t1 = await tickOf(host);
    await host.waitForFunction(([sel, t]) => Number(document.querySelector(sel)?.dataset.tick || 0) > t + 60, [SEL.netMatch, t1], { timeout: 20_000 });
    const after = await host.evaluate((sel) => ({ ...document.querySelector(sel).dataset }), SEL.netMatch);
    expect(after.desync || 'none', 'still in sync with the other tab').toBe('none');
    expect(after.stopped || 'running', 'and running').toBe('running');
  },
  { timeoutMs: 150_000 },
);

test(
  'Perf: a lost WebGL context in the replay viewer pauses playback under the note, then the replay goes on in 2D',
  async (t) => {
    const page = await openApp(t, { prefs: { halfSeconds: 2 }, renderer: '3d', init: loseContextHook });
    if ((await playOne(page)) !== '3d') return;
    await goTab(page, SEL.clubScreen);
    // The hook keeps the context of the canvas with id "pitch"; the viewer's canvas is #rv-canvas.
    await page.evaluate(() => {
      const gc = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        const c = gc.call(this, type, ...rest);
        if (c && type === 'webgl2' && this.id === 'rv-canvas') window.__loseRv = c.getExtension('WEBGL_lose_context');
        return c;
      };
    });
    await page.locator('.rp-row [data-replay="watch"]').first().click();
    await page.locator('[data-rp="close"]').waitFor();
    if ((await page.locator('#rv-canvas').getAttribute('data-renderer')) !== '3d' || !(await page.evaluate(() => !!window.__loseRv))) return;
    await page.evaluate(() => window.__loseRv.loseContext());
    await page.locator('.rp-stage .gfx-note').waitFor({ state: 'visible', timeout: 3000 });
    const scrub = () => page.evaluate(() => Number(document.querySelector('#rv-scrub').value));
    const s0 = await scrub();
    await page.waitForTimeout(1000);
    expect(await scrub(), 'playback is held while the pitch cannot be drawn').toBe(s0);
    await page.waitForFunction(() => document.querySelector('#rv-canvas').dataset.renderer === '2d', null, { timeout: 8000 });
    expect(await page.locator('.rp-stage .gfx-note').isVisible(), 'the note is gone').toBe(false);
    await page.locator('[data-rp="play"]').click().catch(() => {});
    await page.waitForFunction((v) => Number(document.querySelector('#rv-scrub').value) !== v, s0, { timeout: 10_000 });
    await page.locator('[data-rp="close"]').click();
    await page.locator('[data-rp="close"]').waitFor({ state: 'detached' });
  },
  { timeoutMs: 150_000 },
);
