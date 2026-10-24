// Launch readiness: one-tab guard, save safety (backup restore, quota, export/import), the crash panel,
// telemetry off by default, the offline page (served over http, because service workers need it),
// built static files, and the WebGL-unavailable fallback.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test, expect } = require('./lib/harness.cjs');
const { APP_URL, SAVE_KEY, PREFS_KEY, SEL, openApp, goTab, readSave, skipOnboarding, startRanked, totalXpForLevel } = require('./lib/helpers.cjs');

const DIST = path.resolve(__dirname, '..', '..', 'dist');
const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/;

/** A second tab in the same browser context (same origin, shared localStorage). Page errors go to `problems`. */
async function secondTab(page, problems) {
  const p = await page.context().newPage();
  p.setDefaultTimeout(20_000);
  await p.route(FONT_HOST, (r) => r.abort());
  p.on('pageerror', (e) => problems.push(`second tab pageerror: ${e.message}`));
  await p.goto(APP_URL);
  return p;
}

/**
 * Like openApp() (a level-99 club with every tab open) but with `init` installed before the page's own scripts
 * run, which openApp cannot do: for tests that must watch or break something from the very first line.
 */
async function openAppWith(t, init, before) {
  const page = await t.newPage();
  await page.addInitScript(init);
  if (before) before(page);
  await page.goto(APP_URL);
  await page.waitForSelector(SEL.app + ' *');
  await skipOnboarding(page);
  await page.evaluate(([k, xp]) => {
    const save = JSON.parse(localStorage.getItem(k));
    save.xp = xp;
    delete save.unlocksSeen;
    localStorage.setItem(k, JSON.stringify(save));
  }, [SAVE_KEY, totalXpForLevel(99)]);
  await page.reload();
  await page.waitForSelector(SEL.app + ' *');
  await skipOnboarding(page);
  return page;
}

/**
 * How many of two tabs are parked behind the guard screen and how many are playing. A tab that booted the game
 * and then lost the club keeps its markup under the overlay, so "playing" means: no guard screen and a drawn app.
 */
async function tabStates(...pages) {
  let guards = 0;
  let games = 0;
  for (const p of pages) {
    const parked = (await p.locator('#guard-title').count()) > 0;
    if (parked) guards++;
    else if ((await p.locator('#app > *').count()) > 0) games++;
  }
  return { guards, games };
}

const toastText = (page) => page.locator(SEL.toast).first().innerText();

test('a second tab shows the "open in another tab" screen and never touches the save', async (t) => {
  const problems = [];
  const a = await openApp(t);
  const before = await readSave(a);
  const b = await secondTab(a, problems);
  await b.waitForSelector('#guard-title');
  expect(await b.locator('#guard-title').innerText(), 'title').toMatch(/open in another tab/i);
  expect(await b.locator('#guard-here').innerText(), 'button').toMatch(/play here instead/i);
  expect(await b.locator('#app > *').count(), 'game not booted behind it').toBe(0);
  // The owner is untouched and the save is byte-identical.
  expect(await a.locator(SEL.tab).count(), 'owner still has its tabs').toBeGreaterThanOrEqual(5);
  expect(await a.locator('#guard').count(), 'owner shows no guard').toBe(0);
  expect(JSON.stringify(await readSave(b)), 'save unchanged').toBe(JSON.stringify(before));
  expect(problems, 'second tab errors').toEqual([]);
});

test('"Play here instead" moves the club to the new tab and parks the old one', async (t) => {
  const problems = [];
  const a = await openApp(t);
  const name = (await readSave(a)).club.name;
  const b = await secondTab(a, problems);
  await b.waitForSelector('#guard-here');
  await b.locator('#guard-here').click();
  await b.waitForSelector(SEL.tab, { timeout: 15_000 });
  await skipOnboarding(b);
  await a.waitForSelector('#guard-title');
  expect(await a.locator('#guard-title').innerText(), 'old tab now parked').toMatch(/open in another tab/i);
  expect((await readSave(b)).club.name, 'club carried over').toBe(name);
  // The parked tab cannot write: a change in the new owner survives, and the old tab has no way to overwrite it.
  await goTab(b, 'squad');
  await b.locator('[data-action="auto-lineup"]').click();
  const after = JSON.stringify(await readSave(b));
  await a.waitForTimeout(500);
  expect(JSON.stringify(await readSave(a)), 'old tab leaves the save alone').toBe(after);
  // And the old tab can take it back.
  await a.locator('#guard-here').click();
  await a.waitForSelector(SEL.tab, { timeout: 15_000 });
  await b.waitForSelector('#guard-title');
  expect(problems, 'errors').toEqual([]);
});

test('a match in progress is never taken away: the other tab waits, and the result is saved first', async (t) => {
  const problems = [];
  const a = await openApp(t, { prefs: { halfSeconds: 3, controls: 'mouse' } });
  const before = (await readSave(a)).club.played;
  const b = await secondTab(a, problems);
  await b.waitForSelector('#guard-here');
  await startRanked(a);
  await b.locator('#guard-here').click();
  await b.waitForFunction(() => /in progress/i.test(document.getElementById('guard-note')?.textContent || ''), null, { timeout: 15_000 });
  expect(await a.locator(SEL.pitch).count(), 'owner keeps its match').toBe(1);
  expect(await a.locator('#guard').count(), 'owner not parked mid-match').toBe(0);
  // The match runs to full time; the result is recorded, then the club moves.
  await a.waitForSelector(SEL.modal, { timeout: 60_000 });
  await b.waitForSelector(SEL.tab, { timeout: 30_000 });
  const played = (await readSave(b)).club.played;
  expect(played, 'the finished match is in the save the new tab loaded').toBe(before + 1);
  expect(await a.locator('#guard-title').count(), 'old tab parked after the result').toBe(1);
  expect(problems, 'errors').toEqual([]);
});

test('a guest tab boots the game read-only: nothing it does is saved', async (t) => {
  const problems = [];
  const a = await openApp(t);
  const b = await secondTab(a, problems);
  await b.waitForSelector('#guard-guest');
  await b.locator('#guard-guest').click();
  await b.waitForSelector(SEL.tab);
  expect(await b.locator('#guard').count(), 'guard gone').toBe(0);
  const before = JSON.stringify(await readSave(a));
  await goTab(b, 'squad');
  await b.locator('[data-action="auto-lineup"]').click();
  await b.waitForTimeout(300);
  expect(JSON.stringify(await readSave(a)), 'guest write ignored').toBe(before);
  expect(problems, 'errors').toEqual([]);
});

test('a corrupt save is replaced by the previous good one, with a message', async (t) => {
  const page = await openApp(t);
  const name = (await readSave(page)).club.name;
  await page.evaluate((k) => {
    localStorage.setItem(k + '.bak', localStorage.getItem(k));
    localStorage.setItem(k, '{"version":1,"squad":[');
  }, SAVE_KEY);
  await page.reload();
  await page.waitForSelector(SEL.toast);
  expect(await toastText(page), 'toast').toMatch(/damaged/i);
  expect((await readSave(page)).club.name, 'club restored').toBe(name);
  expect(await page.evaluate((k) => localStorage.getItem(k + '.corrupt'), SAVE_KEY), 'corrupt text kept').toBe('{"version":1,"squad":[');
});

test('a full disk shows a friendly toast instead of losing progress silently', async (t) => {
  const page = await openApp(t);
  await page.evaluate((k) => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, v) {
      if (key === k) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return set.call(this, key, v);
    };
  }, SAVE_KEY);
  await goTab(page, 'squad');
  await page.locator('[data-action="auto-lineup"]').click();
  await page.waitForSelector(SEL.toast + '.bad');
  expect(await toastText(page), 'toast').toMatch(/out of storage/i);
});

test('back up the club to a file and a code, then restore it into a different club', async (t) => {
  const a = await openApp(t);
  const nameA = (await readSave(a)).club.name;
  await goTab(a, SEL.clubScreen);
  await a.locator('[data-action="open-backup"]').click();
  await a.waitForSelector('#settings-title');
  const [download] = await Promise.all([a.waitForEvent('download'), a.locator('#bk-download').click()]);
  expect(download.suggestedFilename(), 'file name').toMatch(/^derby-day-.+-\d{4}-\d{2}-\d{2}\.json$/);
  const file = await download.path();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(parsed.app, 'wrapper').toBe('derby-day');
  expect(parsed.save.club.name, 'club in file').toBe(nameA);
  await a.locator('#bk-code').click();
  await a.waitForFunction(() => document.getElementById('bk-code-text').value.length > 20);
  const code = await a.locator('#bk-code-text').inputValue();
  expect(code, 'code').toMatch(/^DD1\.[A-Za-z0-9_-]+$/);
  await a.keyboard.press('Escape');
  expect(await a.locator('#settings-dialog').count(), 'Esc closes').toBe(0);

  // A different club in another browser: a bad file is refused with a reason, a good one previews, then replaces.
  const c = await openApp(t, { level: 3 });
  const nameC = (await readSave(c)).club.name;
  expect(nameC, 'different clubs').notToBe(nameA);
  await goTab(c, SEL.clubScreen);
  await c.locator('[data-action="open-backup"]').click();
  await c.locator('#bk-file').setInputFiles({ name: 'nope.json', mimeType: 'application/json', buffer: Buffer.from('not a backup') });
  await c.waitForSelector('.bk-bad');
  expect(await c.locator('#bk-confirm').count(), 'no confirm for a bad file').toBe(0);
  await c.locator('#bk-file').setInputFiles(file);
  await c.waitForSelector('.bk-found');
  const preview = await c.locator('.bk-found').innerText();
  expect(preview, 'preview names the club').toContain(nameA);
  expect(preview, 'preview shows the level').toMatch(/Level 99/);
  expect(await c.locator('#bk-preview').innerText(), 'says what is replaced').toContain(nameC);
  expect((await readSave(c)).club.name, 'nothing replaced before confirming').toBe(nameC);
  await Promise.all([c.waitForNavigation(), c.locator('#bk-confirm').click()]);
  await c.waitForSelector(SEL.tab);
  expect((await readSave(c)).club.name, 'club restored from the file').toBe(nameA);
  expect(JSON.parse(await c.evaluate((k) => localStorage.getItem(k + '.pre-import'), SAVE_KEY)).club.name, 'old club kept as a safety copy').toBe(nameC);

  // The code works the same way.
  const d = await openApp(t, { level: 5 });
  await goTab(d, SEL.clubScreen);
  await d.locator('[data-action="open-backup"]').click();
  await d.locator('#bk-paste').fill(code);
  await d.waitForSelector('.bk-found');
  expect(await d.locator('.bk-found').innerText(), 'code preview').toContain(nameA);
});

test('crash panel: calm, shows once, copies details without personal data, and reload is a button not a loop', async (t) => {
  const page = await openApp(t);
  const name = (await readSave(page)).club.name;
  await page.evaluate(() => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => (window.__copied = s) }, configurable: true });
    window.__marker = 1;
  });
  // Browser noise is ignored.
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' })));
  expect(await page.locator('#crash-panel').count(), 'benign error ignored').toBe(0);
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'boom one', error: new Error('boom one') })));
  await page.waitForSelector('#crash-panel');
  expect(await page.locator('#crash-title').textContent(), 'title').toBe('Something went wrong');
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id), 'focus on the panel').toBe('crash-title');
  await page.evaluate(() => window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new Error('boom two') })));
  expect(await page.locator('#crash-panel').count(), 'still one panel').toBe(1);
  await page.locator('#crash-copy').click();
  await page.waitForFunction(() => window.__copied);
  const copied = await page.evaluate(() => window.__copied);
  expect(copied, 'has the first error').toContain('boom one');
  expect(copied, 'has the second error').toContain('boom two');
  expect(copied, 'has a build id').toContain('build:');
  expect(copied, 'no club name').notToContain(name);
  expect(copied, 'no query string or storage').notToContain('derbyday');
  await page.locator('#crash-reload').click();
  await page.waitForFunction(() => !window.__marker);
  await page.waitForSelector(SEL.tab);
  expect(await page.locator('#crash-panel').count(), 'fresh page, no panel').toBe(0);
});

test('telemetry and error reporting are off: no network requests beyond the page itself, no beacons', async (t) => {
  const requests = [];
  const page = await openAppWith(
    t,
    () => {
      window.__beacons = 0;
      navigator.sendBeacon = () => (window.__beacons++, true);
    },
    (p) =>
      p.on('request', (r) => {
        const u = r.url();
        if (!u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:') && !FONT_HOST.test(u)) requests.push(u);
      }),
  );
  await goTab(page, 'squad');
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'x', error: new Error('x') })));
  await page.waitForSelector('#crash-panel');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => window.__beacons), 'beacons').toBe(0);
  expect(requests, 'requests').toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /iid|telemetry/.test(k))), 'no install id stored').toEqual([]);
  expect(await page.evaluate(() => document.cookie), 'no cookies').toBe('');
});

test('built files: share metadata, manifest and icons, robots, 404, and an artifact build with none of it', async () => {
  const read = (f) => fs.readFileSync(path.join(DIST, f), 'utf8');
  const html = read('index.html');
  for (const needle of ['rel="canonical" href="https://derby.natwong.dev/"', 'property="og:image" content="https://derby.natwong.dev/og.png"', 'name="twitter:card" content="summary_large_image"', 'rel="manifest"', 'rel="apple-touch-icon"', 'name="theme-color"', 'property="og:title"']) {
    expect(html, needle).toContain(needle);
  }
  expect(html, 'web fonts do not block first paint').toMatch(/<link id="gfonts"[^>]*fonts\.googleapis\.com[^>]*media="print">/);
  expect(html.match(/<title>/g).length, 'one title').toBe(1);
  expect(html.match(/name="description"/g).length, 'one description').toBe(1);
  expect(html.slice(0, html.indexOf('</head>')), 'title and description are in <head>').toContain('<title>Derby Day</title>');
  // The CSP allows exactly the one inline script, by hash, and no inline event handlers are left to need 'unsafe-hashes'.
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const hash = require('node:crypto').createHash('sha256').update(script).digest('base64');
  expect(html, 'CSP hash matches the inline script').toContain(`script-src 'sha256-${hash}'`);
  expect(html, 'CSP object rule').toContain("object-src 'none'");
  expect(html.match(/<script/g).length, 'only one script tag').toBe(1);
  expect(/\son(load|click|error)=/.test(html.slice(0, html.indexOf('<script'))), 'no inline handlers in the page markup').toBe(false);
  expect(html, 'font display swap').toContain('display=swap');
  const art = read('derby-day.artifact.html');
  expect(art, 'artifact has no manifest link').notToContain('rel="manifest"');
  expect(art, 'artifact has no og tags').notToContain('og:image');
  const manifest = JSON.parse(read('manifest.webmanifest'));
  expect(manifest.start_url, 'start_url').toBe('/');
  expect(manifest.display, 'display').toBe('standalone');
  for (const ic of manifest.icons) expect(fs.existsSync(path.join(DIST, ic.src)), `icon ${ic.src}`).toBe(true);
  expect(manifest.icons.some((i) => i.purpose === 'maskable'), 'maskable icon').toBe(true);
  const png = fs.readFileSync(path.join(DIST, 'og.png'));
  expect([png.readUInt32BE(16), png.readUInt32BE(20)], 'share image is 1200x630').toEqual([1200, 630]);
  expect(read('robots.txt'), 'robots').toContain('Sitemap: https://derby.natwong.dev/sitemap.xml');
  expect(read('404.html'), '404 page').toContain('Back to Derby Day');
  expect(read('sw.js'), 'sw build id substituted').notToContain('__BUILD_ID__');
  const vercel = JSON.parse(fs.readFileSync(path.join(DIST, '..', 'vercel.json'), 'utf8'));
  expect(JSON.stringify(vercel.headers[0].headers), 'HSTS header').toContain('Strict-Transport-Security');
  expect(JSON.stringify(vercel.headers[0].headers), 'frame-ancestors').toContain("frame-ancestors 'self'");
  const sw = vercel.headers.find((h) => h.source === '/sw.js');
  expect(JSON.stringify(sw.headers), 'sw.js is never cached').toContain('no-cache');
});

test('without WebGL the match falls back to the 2D renderer and says so', async (t) => {
  const page = await openAppWith(t, () => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/i.test(type) ? null : get.call(this, type, ...rest);
    };
  });
  await startRanked(page);
  expect(await page.locator(SEL.pitch).getAttribute('data-renderer'), 'renderer').toBe('2d');
  expect(await page.locator(SEL.pitch).getAttribute('data-fallback'), 'fallback reason').toBe('webgl-unavailable');
  await page.waitForSelector(SEL.toast);
  expect(await toastText(page), 'notice').toMatch(/3D view is not available/i);
});

// ---------------------------------------------------------------------------
// Offline play needs a real http origin (service workers do not run on file://).

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml' };

/** Serves dist/. `state.build` rewrites the build id inside sw.js (a new deploy), `state.marker` is added to the page. */
function serveDist(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!path.extname(file)) file += '.html';
    const full = path.join(DIST, path.normalize(file));
    if (!full.startsWith(DIST) || !fs.existsSync(full)) {
      res.writeHead(404, { 'content-type': 'text/html' }).end(fs.readFileSync(path.join(DIST, '404.html')));
      return;
    }
    let body = fs.readFileSync(full);
    if (file === '/sw.js') body = Buffer.from(body.toString().replace(/const BUILD = '[^']*'/, `const BUILD = '${state.build}'`));
    if (file === '/index.html' && state.marker) body = Buffer.from(body.toString().replace('</body>', `<!--${state.marker}--></body>`));
    state.hits[url.pathname] = (state.hits[url.pathname] || 0) + 1;
    res.writeHead(200, { 'content-type': (TYPES[path.extname(file)] || 'application/octet-stream') + (file.endsWith('.html') || file.endsWith('.js') ? '; charset=utf-8' : ''), 'cache-control': 'no-cache' }).end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

test('offline: the page opens with no network after one visit, and a new deploy replaces the old cache', async (t) => {
  const state = { build: 'old1', marker: 'v1', hits: {} };
  const { server, origin } = await serveDist(state);
  try {
    const page = await t.newPage();
    await page.goto(origin + '/');
    await page.waitForSelector(SEL.app + ' *');
    await skipOnboarding(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // Online reload: always the latest page (network first), and the worker now controls the tab.
    state.marker = 'v2';
    await page.reload();
    await page.waitForSelector(SEL.tab);
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller), 'worker controls the page').toBe(true);
    const marker = () => page.evaluate(() => [...document.body.childNodes].filter((n) => n.nodeType === 8).map((n) => n.data));
    expect(await marker(), 'online reload gets the newest page, not the cached one').toContain('v2');
    expect(await page.evaluate(() => caches.keys()), 'one cache for this build').toEqual(['derby-day-old1']);
    // Offline: the same club opens from the cache.
    const name = (await readSave(page)).club.name;
    await page.context().setOffline(true);
    await page.reload();
    await page.waitForSelector(SEL.tab);
    expect(await marker(), 'offline page is the last one that loaded').toContain('v2');
    expect((await readSave(page)).club.name, 'same club offline').toBe(name);
    expect(await page.title(), 'title offline').toMatch(/derby day/i);
    await page.context().setOffline(false);
    // Visiting another address (the share image) must not become the cached page.
    await page.goto(origin + '/og.png');
    await page.goto(origin + '/');
    await page.waitForSelector(SEL.tab);
    await page.context().setOffline(true);
    await page.reload();
    await page.waitForSelector(SEL.tab);
    expect(await page.evaluate(() => document.contentType), 'offline reload is still the game, not an image').toBe('text/html');
    await page.context().setOffline(false);
    // A new deploy: the worker updates itself, drops the old cache and the page says so.
    state.build = 'new2';
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForFunction(async () => (await caches.keys()).join() === 'derby-day-new2', null, { timeout: 15_000 });
    await page.waitForSelector(SEL.toast);
    expect(await toastText(page), 'update notice').toMatch(/updated/i);
    // sw.js itself is never served from the HTTP cache.
    const swHeaders = (await page.request.get(origin + '/sw.js')).headers();
    expect(swHeaders['cache-control'], 'sw.js cache').toContain('no-cache');
  } finally {
    server.close();
  }
});

test('a guest tab cannot restore a backup over the owner, and a damaged backup is refused in the owner tab', async (t) => {
  const problems = [];
  const a = await openApp(t);
  const name = (await readSave(a)).club.name;
  const b = await secondTab(a, problems);
  await b.locator('#guard-guest').click();
  await b.waitForSelector(SEL.tab);
  await goTab(b, SEL.clubScreen);
  await b.locator('[data-action="open-backup"]').click();
  await b.waitForSelector('#settings-title');
  expect(await b.locator('#bk-choose').count(), 'no restore controls in a guest tab').toBe(0);
  expect(await b.locator('#settings-dialog').innerText(), 'says why').toMatch(/guest tab/i);
  // Owner tab: a backup whose squad is junk never reaches the confirm button.
  await goTab(a, SEL.clubScreen);
  await a.locator('[data-action="open-backup"]').click();
  const bad = await a.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k));
    s.squad = s.squad.map(() => ({ foo: 1 })); // every entry, so the crash does not depend on which players the random club uses
    return JSON.stringify(s);
  }, SAVE_KEY);
  await a.locator('#bk-paste').fill(bad);
  await a.waitForSelector('.bk-bad');
  expect(await a.locator('#bk-confirm').count(), 'no confirm for a damaged backup').toBe(0);
  expect((await readSave(a)).club.name, 'club untouched').toBe(name);
  expect(problems, 'errors').toEqual([]);
});

/**
 * A fresh page in its own context with `seed` written into localStorage before the page's own scripts run (once per
 * page, tracked in sessionStorage), and a same-origin anchor page kept open. Playwright's in-memory contexts can lose
 * localStorage that an unloading page wrote, so the tests below never rely on write-then-reload; the anchor keeps the
 * origin's storage alive across the one reload the crash panel's restore button does by design.
 */
async function seededPage(t, seed) {
  const ctx = await t.browser.newContext();
  const anchor = await ctx.newPage();
  await anchor.goto(require('node:url').pathToFileURL(path.join(DIST, '404.html')).href);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const throttle = Number(process.env.E2E_CPU_THROTTLE || 0); // same knob run.cjs applies to t.newPage()
  if (throttle > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.route(FONT_HOST, (r) => r.abort());
  await page.addInitScript((entries) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    for (const [k, v] of entries) localStorage.setItem(k, v);
  }, Object.entries(seed));
  return { ctx, page };
}

test('a club the game cannot open offers to restore the previous one, and a newer-version save is left alone', async (t) => {
  const good = await (await openApp(t)).evaluate((k) => localStorage.getItem(k), SAVE_KEY);
  const goodName = JSON.parse(good).club.name;
  // A save that passes isSave() but crashes the game at boot: every squad entry junk, so the crash does not depend on
  // which players the random club uses. An earlier club is kept as the safety copy.
  const broken = JSON.stringify({ ...JSON.parse(good), squad: JSON.parse(good).squad.map(() => ({ foo: 1 })) });
  const prefs = JSON.stringify({ halfSeconds: 3, controls: 'mouse', onboarded: true });
  const seed = { [PREFS_KEY]: prefs, [SAVE_KEY + '.pre-import']: good, [SAVE_KEY]: broken };
  const { ctx, page } = await seededPage(t, seed);
  try {
    await page.goto(APP_URL); // boots straight into the broken club
    await page.waitForSelector('#crash-panel');
    expect(await page.locator('#crash-panel').innerText(), 'calm wording').toMatch(/something went wrong/i);
    // The button writes the save and reloads. Playwright's in-memory contexts occasionally drop a localStorage write made
    // by a page as it unloads (about 3 in 40), which brings the same crash panel back with nothing changed; the button
    // is safe to press again, so allow it up to three presses before calling it a failure.
    let restored = false;
    for (let attempt = 1; attempt <= 3 && !restored; attempt++) {
      await page.locator('#crash-restore').click();
      restored = await page.waitForSelector(SEL.tab, { timeout: 8_000 }).then(() => true, () => false);
      if (!restored) await page.waitForSelector('#crash-panel', { timeout: 8_000 });
    }
    expect(restored, 'restoring brings the game back (within three presses)').toBe(true);
    expect((await readSave(page)).club.name, 'previous club is back').toBe(goodName);
  } finally {
    await ctx.close();
  }
  // A save from a newer build: a notice, no game, and the stored text is never touched.
  const newer = JSON.stringify({ version: 99, mystery: 'from the future' });
  const n = await seededPage(t, { [PREFS_KEY]: prefs, [SAVE_KEY]: newer });
  try {
    await n.page.goto(APP_URL);
    await n.page.waitForSelector('#guard-title');
    expect(await n.page.locator('#guard-title').textContent(), 'newer version notice').toMatch(/newer version/i);
    await n.page.waitForTimeout(500);
    expect(await n.page.evaluate((k) => localStorage.getItem(k), SAVE_KEY), 'stored save untouched').toBe(newer);
  } finally {
    await n.ctx.close();
  }
});

test('the test-only flag lifts the tab guard only when BOTH __e2e and __e2eSkipTabGuard are set', async (t) => {
  const owner = await openApp(t);
  const open = async (flags) => {
    const p = await owner.context().newPage();
    p.setDefaultTimeout(20_000);
    await p.route(FONT_HOST, (r) => r.abort());
    await p.addInitScript((f) => Object.assign(window, f), flags);
    await p.goto(APP_URL);
    await p.waitForSelector('#guard-title, #app *'); // a parked tab draws the guard overlay, not the game
    return p;
  };
  const only = await open({ __e2e: true });
  expect(await only.locator('#guard-title').count(), '__e2e alone: guard still parks the tab').toBe(1);
  const skipOnly = await open({ __e2eSkipTabGuard: true });
  expect(await skipOnly.locator('#guard-title').count(), '__e2eSkipTabGuard alone: guard still parks the tab').toBe(1);
  const both = await open({ __e2e: true, __e2eSkipTabGuard: true });
  await skipOnboarding(both);
  expect(await both.locator('#guard-title').count(), 'both flags: no guard').toBe(0);
  expect(await both.locator(SEL.tab).count(), 'both flags: the game runs').toBeGreaterThan(0);
  expect(await owner.locator('#guard-title').count(), 'and the owner was not parked').toBe(0);
});

test('two tabs opened at the same instant: exactly one gets the club, and it stays that way', async (t) => {
  const first = await t.newPage();
  const second = await first.context().newPage();
  await Promise.all([first.goto(APP_URL), second.goto(APP_URL)]);
  const state = () => tabStates(first, second);
  // The claim is atomic (Web Locks), so this is true almost at once; the bound allows a slow runner.
  const deadline = Date.now() + 3000;
  let s = await state();
  while (!(s.guards === 1 && s.games === 1) && Date.now() < deadline) {
    await first.waitForTimeout(100);
    s = await state();
  }
  expect(s, 'one tab parked, one tab playing within 3 s').toEqual({ guards: 1, games: 1 });
  await first.waitForTimeout(600);
  expect(await state(), 'still one and one a moment later').toEqual({ guards: 1, games: 1 });
});

const NO_LOCKS = () => Object.defineProperty(Navigator.prototype, 'locks', { value: undefined, configurable: true });

test('without Web Locks the lease fallback still gives the club to exactly one of two simultaneous tabs, and hand-over works', async (t) => {
  const first = await t.newPage();
  await first.context().addInitScript(NO_LOCKS);
  const second = await first.context().newPage();
  await Promise.all([first.goto(APP_URL), second.goto(APP_URL)]);
  const state = () => tabStates(first, second);
  // The lease is checked on every heartbeat and every storage/claim message, so two owners converge to one within a bounded time.
  const deadline = Date.now() + 5000;
  let s = await state();
  while (!(s.guards === 1 && s.games === 1) && Date.now() < deadline) {
    await first.waitForTimeout(100);
    s = await state();
  }
  expect(s, 'one parked, one playing (lowest tab id keeps it) within 5 s').toEqual({ guards: 1, games: 1 });
  await first.waitForTimeout(2000);
  expect(await state(), 'and it stays that way for 2 s').toEqual({ guards: 1, games: 1 });
  // Hand-over through the lease: the parked tab asks, the owner yields.
  const parked = (await first.locator('#guard-title').count()) ? first : second;
  const playing = parked === first ? second : first;
  await parked.locator('#guard-here').click();
  await parked.waitForSelector(SEL.app + ' *', { timeout: 15_000 });
  await skipOnboarding(parked); // a brand-new club starts in first-run setup
  await parked.waitForSelector(SEL.tab, { timeout: 15_000 });
  await playing.waitForSelector('#guard-title');
});

for (const mode of ['Web Locks', 'lease fallback']) {
  test(`${mode}: a fresh page claims the club promptly after the owner page closes, with no heartbeat-length wait`, async (t) => {
    const owner = await t.newPage();
    if (mode !== 'Web Locks') await owner.context().addInitScript(NO_LOCKS);
    const anchor = await owner.context().newPage(); // keeps the context's storage alive, like a second tab would
    await owner.goto(APP_URL);
    await skipOnboarding(owner);
    await owner.waitForSelector(SEL.app + ' *');
    await anchor.goto('about:blank');
    await owner.close();
    const t0 = Date.now();
    const next = await anchor.context().newPage();
    await next.goto(APP_URL);
    await next.waitForSelector(SEL.app + ' > *', { timeout: 6000 });
    const ms = Date.now() - t0;
    expect(await next.locator('#guard-title').count(), 'not parked behind a dead owner').toBe(0);
    console.log(`      ${mode}: owner closed -> fresh page drawing the game in ${ms} ms`);
    expect(ms, 'well under the 2 s heartbeat').toBeLessThan(2000);
  });
}

test('the artifact build runs inside a sandboxed cross-origin iframe on http: no crash panel, no errors', async (t) => {
  // file:// hides the problem: in a sandboxed frame even reading navigator.serviceWorker throws SecurityError.
  const state = { build: 'art', marker: '', hits: {} };
  const { server, origin } = await serveDist(state);
  const outer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><body style="margin:0"><iframe id="g" sandbox="allow-scripts" src="${origin}/derby-day.artifact.html" style="width:100vw;height:100vh;border:0"></iframe>`);
  });
  await new Promise((r) => outer.listen(0, '127.0.0.1', r));
  try {
    const page = await t.newPage();
    await page.goto(`http://127.0.0.1:${outer.address().port}/`);
    const frame = page.frameLocator('#g');
    await frame.locator('#app *').first().waitFor();
    await page.waitForTimeout(800);
    expect(await frame.locator('#crash-panel').count(), 'no crash panel').toBe(0);
    expect(await frame.locator('#app').innerText().then((x) => x.length), 'game drew something').toBeGreaterThan(20);
  } finally {
    server.close();
    outer.close();
  }
});

test('the artifact build on file:// runs without a service worker and without errors', async (t) => {
  const page = await t.newPage();
  await page.addInitScript(() => {
    window.__sw = 0;
    if (navigator.serviceWorker) navigator.serviceWorker.register = () => (window.__sw++, Promise.reject(new Error('x')));
  });
  await page.goto('file://' + path.join(DIST, 'derby-day.artifact.html'));
  await page.waitForSelector(SEL.app + ' *');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__sw), 'no registration attempted on file://').toBe(0);
  expect(await page.locator(SEL.tab).count() + (await page.locator('.ob-progress, #onboarding, [data-action="skip-onboarding"]').count()), 'game booted').toBeGreaterThan(0);
});
