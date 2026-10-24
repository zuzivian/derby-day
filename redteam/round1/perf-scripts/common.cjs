const { chromium } = require('playwright');
const path = require('path');
const helpers = require('/tmp/rt/perf/repo/tests/e2e/lib/helpers.cjs');

const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/;

async function launch() {
  return chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

// Instrumentation injected before boot.
function instrument() {
  window.__e2e = true;
  const P = (window.__perf = { cb: [], iv: [], longtasks: [], loafs: [], on: false, last: 0, mark: [] });
  const raf = window.requestAnimationFrame.bind(window);
  // Time every rAF callback (game frame work), and the interval between frames.
  // window.__hide(ms): emulate a background tab — rAF callbacks are held (as browsers do for hidden
  // tabs) while timers keep running, with document.hidden / visibilitychange to match.
  const held = [];
  window.__hide = (ms) => new Promise((res) => {
    window.__frozen = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    setTimeout(() => {
      delete document.hidden; delete document.visibilityState;
      window.__frozen = false;
      document.dispatchEvent(new Event('visibilitychange'));
      for (const f of held.splice(0)) raf(f);
      res();
    }, ms);
  });
  window.requestAnimationFrame = function (cb) {
    if (window.__frozen) { held.push((ts) => cb(ts)); return 0; }
    return raf((ts) => {
      if (window.__frozen) { held.push(cb); return; }
      const t0 = performance.now();
      try { cb(ts); } finally {
        if (P.on) P.cb.push(performance.now() - t0);
      }
    });
  };
  P.draw = []; P.glr = [];
  const hook = () => {
    const r = window.__derby3d;
    if (!r || r.__wrapped) return;
    r.__wrapped = true;
    const d = r.draw.bind(r);
    r.draw = (a, b) => { const t0 = performance.now(); d(a, b); if (P.on) P.draw.push(performance.now() - t0); };
    const g = r.gl; const gr = g.render.bind(g);
    g.render = (a, b) => { const t0 = performance.now(); gr(a, b); if (P.on) P.glr.push(performance.now() - t0); };
  };
  const loop = (ts) => {
    hook();
    if (P.on) { if (P.last) P.iv.push(ts - P.last); P.last = ts; } else P.last = 0;
    raf(loop);
  };
  raf(loop);
  try {
    new PerformanceObserver((l) => { if (P.on) for (const e of l.getEntries()) P.longtasks.push(e.duration); }).observe({ type: 'longtask', buffered: false });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => {
      if (!P.on) return;
      for (const e of l.getEntries()) P.loafs.push({ d: e.duration, block: e.blockingDuration, raf: e.styleAndLayoutStart && e.renderStart ? e.styleAndLayoutStart - e.renderStart : 0, render: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0, pre: e.renderStart ? e.renderStart - e.startTime : 0, scripts: (e.scripts || []).map((s) => ({ d: s.duration, inv: s.invoker, src: (s.sourceFunctionName || '') + '@' + (s.sourceCharPosition ?? '') })) });
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch (e) {}
  // Track AudioContexts.
  window.__ac = [];
  const AC = window.AudioContext;
  if (AC) window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__ac.push(this); } };
  // Count WebGL contexts.
  const gc = HTMLCanvasElement.prototype.getContext;
  // WeakRefs only: a strong reference to a context would keep its (detached) canvas and the whole
  // match DOM it belonged to alive, and look like a leak in the game.
  const refs = [];
  Object.defineProperty(window, '__gl', { get: () => refs.map((r) => r.deref() || { isContextLost: () => true, collected: true }) });
  window.__glCollected = () => refs.filter((r) => !r.deref()).length;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const c = gc.call(this, type, ...rest);
    if (c && /webgl/.test(type) && !refs.some((r) => r.deref() === c)) refs.push(new WeakRef(c));
    return c;
  };
}

function stats(a) {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const avg = a.reduce((x, y) => x + y, 0) / a.length;
  return { n: a.length, avg: +avg.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2) };
}

async function openPage(browser, opts = {}) {
  const problems = [];
  const logs = [];
  let page, cdp;
  const t = {
    async newPage(contextOptions) {
      const ctx = await browser.newContext({ ...contextOptions, ...(opts.ctx || {}) });
      page = await ctx.newPage();
      page.setDefaultTimeout(30000);
      await page.addInitScript(instrument);
      cdp = await ctx.newCDPSession(page);
      await cdp.send('Performance.enable');
      if (opts.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.throttle });
      await page.route(FONT_HOST, (r) => r.abort());
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        const tx = m.text();
        if (FONT_HOST.test(tx) || FONT_HOST.test(m.location().url || '')) return;
        logs.push(`${m.type()}: ${tx}`);
      });
      return page;
    },
  };
  const p = opts.url ? await openAt(t, opts) : await helpers.openApp(t, { width: opts.width || 1280, height: opts.height || 800, prefs: opts.prefs, renderer: opts.renderer, e2eHook: false });
  return { page: p, cdp: () => cdp, problems, logs };
}

async function metrics(cdp, gc = false) {
  if (gc) {
    await cdp.send('HeapProfiler.enable').catch(() => {});
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
  }
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2), totalMB: +(m.JSHeapTotalSize / 1048576).toFixed(2), nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents, layouts: m.LayoutCount, styles: m.RecalcStyleCount, scriptS: +m.ScriptDuration.toFixed(2), taskS: +m.TaskDuration.toFixed(2) };
}

// Like helpers.openApp (level 99 save, prefs) but at any URL (the unminified dev build).
async function openAt(t, opts) {
  const page = await t.newPage({ viewport: { width: opts.width || 1280, height: opts.height || 800 } });
  await page.goto(opts.url);
  await page.waitForSelector('#app *');
  await helpers.skipOnboarding(page);
  await page.evaluate(([saveKey, prefsKey, prefs, xp]) => {
    if (prefs) localStorage.setItem(prefsKey, JSON.stringify(prefs));
    const save = JSON.parse(localStorage.getItem(saveKey));
    save.xp = xp; delete save.unlocksSeen;
    localStorage.setItem(saveKey, JSON.stringify(save));
  }, [helpers.SAVE_KEY, helpers.PREFS_KEY, opts.prefs || null, helpers.totalXpForLevel(99)]);
  await page.reload();
  await page.waitForSelector('#app *');
  await helpers.skipOnboarding(page);
  return page;
}

// helpers.startRanked uses page.waitForSelector, which returns an ElementHandle that Playwright keeps
// alive (a DevTools global handle) and so pins the match's canvas and its whole detached DOM after the
// match. Locator.waitFor holds nothing.
async function startRankedClean(page) {
  await page.locator(helpers.SEL.tabFor(helpers.SEL.homeScreen)).click();
  await page.locator(helpers.SEL.playRanked).click();
  await page.locator(helpers.SEL.pitch).waitFor();
}
async function pitchBox(page) {
  return page.evaluate(() => { const r = document.querySelector('#pitch').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
}

module.exports = { startRankedClean, pitchBox, launch, openPage, stats, metrics, helpers };
