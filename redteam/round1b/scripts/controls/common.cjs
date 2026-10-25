// Browser helpers for the controls red-team.
const { chromium } = require('playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('/tmp/rt/controls/repo/tests/e2e/lib/helpers.cjs');

const DIST = pathToFileURL('/tmp/rt/controls/repo/dist/index.html').href;

async function launch() {
  return chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
}

/** A page in a live ranked match. opts: { width, height, renderer: '2d'|'3d', query } */
async function liveMatch(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 800 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const t = { newPage: (o) => ctx.newPage(o) };
  const query = ['debug3d', opts.query].filter(Boolean).join('&');
  const page = await H.openApp(t, { prefs: { halfSeconds: opts.halfSeconds ?? 600, controls: 'mouse', onboarded: true }, e2eHook: true, renderer: opts.renderer, query, width: opts.width, height: opts.height });
  await H.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 30_000 });
  return { ctx, page };
}

/** Screen pixels (page coords) of a world point at height h (3D renderer, via ?debug3d). */
const project = (page, w, h = 0) =>
  page.evaluate(([w, h]) => {
    const r = window.__derby3d;
    const V = r.hit.constructor;
    const v = new V(w.x - 52.5, h, w.y - 34).project(r.cam.camera);
    const rect = document.querySelector('#pitch').getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }, [w, h]);

/** World ground point under page pixels (3D). */
const ground = (page, px) =>
  page.evaluate((px) => {
    const r = window.__derby3d;
    const rect = document.querySelector('#pitch').getBoundingClientRect();
    return r.toWorld(px.x - rect.left, px.y - rect.top);
  }, px);

const frames = (page, n = 2) => page.evaluate((n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

module.exports = { launch, liveMatch, project, ground, frames, H };
