const { chromium } = require('playwright');
const URL = 'file:///tmp/rt/firstsession/repo/dist/index.html';
const OUT = '/tmp/rt/firstsession/out';
async function launch() {
  return chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}
async function ctx(browser, { width = 1280, height = 800, touch = false, e2e = true } = {}) {
  const opts = { viewport: { width, height } };
  if (touch) Object.assign(opts, { hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  const c = await browser.newContext(opts);
  await c.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  if (e2e) await c.addInitScript(() => { window.__e2e = true; });
  return c;
}
function logErrors(page, tag) {
  page.on('pageerror', (e) => console.log(`[${tag}] PAGEERROR`, e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${tag}] console.${m.type()}`, m.text().slice(0, 300)); });
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
module.exports = { launch, ctx, URL, OUT, logErrors, shot };
