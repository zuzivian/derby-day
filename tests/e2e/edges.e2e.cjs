// Unhappy paths: the message is clear and actionable, announced, and the game recovers.
//   - storage full on the very first save of a visit (not just a later one)
//   - the online lobby on a device with no network: says so at once, keeps focus, can retry
//   - the match banner names the cause when the device itself is offline
//   - WebGL lost for good: the 2D fallback is explained with a toast
//   - a backup file the browser cannot read

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab } = require('./lib/helpers.cjs');

const toastText = (page) => page.locator(SEL.toast).first().innerText();
const ROOT = path.resolve(__dirname, '..', '..');

/** The Bun relay on a free port (as online.e2e.cjs does): resolves to { port, stop }. */
function startRelay() {
  const home = path.join(process.env.HOME || '/root', '.bun', 'bin', 'bun');
  const bun = process.env.BUN_BIN || (fs.existsSync(home) ? home : 'bun');
  return new Promise((resolve, reject) => {
    const child = spawn(bun, [path.join(ROOT, 'server', 'bun.ts')], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', RELAY_QUIET: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${out}`)), 15_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening on port (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), stop: () => child.kill('SIGTERM') });
      }
    });
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
  });
}

test('storage full at boot: a toast says so, with what to do', async (t) => {
  const page = await t.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  await page.goto(require('node:url').pathToFileURL(require('node:path').resolve(__dirname, '..', '..', 'dist', 'index.html')).href);
  await page.waitForSelector(SEL.toast + '.bad');
  const text = await toastText(page);
  expect(text, 'quota text').toMatch(/out of storage/i);
  expect(text, 'says what to do').toMatch(/back up/i);
  expect(await page.locator('#toast-region').getAttribute('aria-live'), 'announced').toBe('polite');
});

test('online lobby on an offline device: says so at once, keeps focus, and can retry', async (t) => {
  const relay = await startRelay();
  try {
    const page = await openApp(t, { width: 390, height: 844, hasTouch: true, query: 'relay=' + encodeURIComponent(`ws://127.0.0.1:${relay.port}/ws`), renderer: '2d' });
    await goTab(page, SEL.homeScreen);
    await page.locator(SEL.playOnline).click();
    await page.locator(SEL.onlineCodeInput).fill('ZZZZ');
    await page.context().setOffline(true);
    await page.locator(SEL.onlineHost).click();
    await page.waitForFunction((sel) => /offline/i.test(document.querySelector(sel).textContent), SEL.onlineStatus, { timeout: 2000 });
    expect(await page.locator(SEL.onlineLobby).getAttribute('data-state'), 'state').toBe('offline');
    expect(await page.locator(SEL.onlineStatus).innerText(), 'actionable').toMatch(/try again/i);
    expect(await page.locator(SEL.onlineHost).isEnabled(), 'host button still usable').toBe(true);
    await page.locator(SEL.onlineJoin).click();
    expect(await page.locator(SEL.onlineLobby).getAttribute('data-state'), 'join says it too').toBe('offline');
    // Back online: a code nobody made fails kindly, and focus returns to the button to retry with.
    await page.context().setOffline(false);
    await page.locator(SEL.onlineJoin).click();
    await page.waitForFunction((sel) => /No match with code/i.test(document.querySelector(sel).textContent), SEL.onlineStatus, { timeout: 10_000 });
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id), 'focus returns to the retry button').toBe('online-join');
  } finally {
    relay.stop();
  }
});

test('WebGL lost for good: the match carries on in 2D and a toast explains', async (t) => {
  const page = await openApp(t, { width: 390, height: 844, hasTouch: true, renderer: '3d', e2eHook: true });
  await page.locator(SEL.kickOff).click();
  await page.waitForSelector(SEL.pitch);
  if ((await page.locator(SEL.pitch).getAttribute('data-renderer')) !== '3d') return; // no WebGL in this browser: nothing to lose
  await page.evaluate(() => {
    const c = document.querySelector('#pitch');
    (c.getContext('webgl2') || c.getContext('webgl')).getExtension('WEBGL_lose_context').loseContext();
  });
  await page.waitForFunction(() => /Restoring graphics/.test(document.body.innerText), null, { timeout: 3000 });
  await page.waitForFunction(() => document.querySelector('#pitch')?.dataset.renderer === '2d', null, { timeout: 8000 });
  await page.waitForSelector(SEL.toast);
  expect(await toastText(page), 'toast').toMatch(/simple 2D/i);
});

test('backup: a file the browser cannot read gets a message, not a crash panel', async (t) => {
  const page = await openApp(t, { width: 390, height: 844 });
  await goTab(page, SEL.clubScreen);
  await page.locator('[data-action="open-backup"]').click();
  await page.waitForSelector('#settings-title');
  await page.evaluate(() => {
    const input = document.getElementById('bk-file');
    const f = new File(['x'], 'club.json');
    f.text = () => Promise.reject(new DOMException('gone', 'NotReadableError'));
    Object.defineProperty(input, 'files', { value: [f] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('#bk-preview .bk-bad');
  expect(await page.locator('#bk-preview .bk-bad').innerText(), 'message').toMatch(/could not be read/i);
  expect(await page.locator('#crash').count(), 'no crash panel').toBe(0);
});
