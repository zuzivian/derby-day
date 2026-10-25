#!/usr/bin/env node
// Tiny e2e runner for Derby Day. No test framework: see lib/harness.cjs.
//
//   bun run e2e                       build, then run everything
//   node tests/e2e/run.cjs [filter]   run tests whose name contains `filter` (case-insensitive)
//
// Environment:
//   PLAYWRIGHT_CHROMIUM  path to a Chromium/Chrome binary (default /opt/pw-browsers/chromium if present,
//                        otherwise Playwright's own downloaded browser)
//   E2E_HEADED=1         show the browser
//   E2E_TIMEOUT_MS       per-test timeout (default 90000)
//
// Playwright is not a dependency of the repo. It is resolved with require('playwright'), then from
// NODE_PATH, then from the global npm root, then from /opt/node22/lib/node_modules.

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function loadPlaywright() {
  const attempts = [() => require('playwright')];
  attempts.push(() => require('/opt/node22/lib/node_modules/playwright'));
  attempts.push(() => require(path.join(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'playwright')));
  for (const f of attempts) {
    try {
      return f();
    } catch {
      /* try the next place */
    }
  }
  console.error('Could not find Playwright. Install it globally (npm i -g playwright@1) and set NODE_PATH="$(npm root -g)".');
  process.exit(2);
}

const { chromium } = loadPlaywright();
const { registry } = require('./lib/harness.cjs');
const { APP_URL } = require('./lib/helpers.cjs');

// Test files: every *.e2e.cjs next to this runner, in name order.
for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.e2e.cjs')).sort()) require(path.join(__dirname, f));

const filter = (process.argv[2] || '').toLowerCase();
const TIMEOUT = Number(process.env.E2E_TIMEOUT_MS || 90_000);
/** How long closing a test's contexts (and the browser) may take before the runner gives up on it. */
const CLOSE_TIMEOUT = Number(process.env.E2E_CLOSE_TIMEOUT_MS || 20_000);

/** The close stalled: which page will not close, can the browser still make a context, and what are the Chrome processes doing? */
async function probeStall(browser, contexts) {
  const out = [];
  const within = (p, ms, label) => Promise.race([p.then(() => `${label}: ok`, (e) => `${label}: failed ${String(e.message).split('\n')[0]}`), new Promise((r) => setTimeout(() => r(`${label}: STILL BLOCKED after ${ms} ms`), ms))]);
  for (const [ci, ctx] of contexts.entries()) for (const [pi, pg] of ctx.pages().entries()) out.push(await within(pg.close(), 4000, `page.close() context ${ci} page ${pi}`));
  out.push(await within(browser.newContext().then((c) => c.close()), 4000, 'browser.newContext()+close'));
  try {
    const ps = require('node:child_process').execSync("ps -eo pid,stat,pcpu,etime,args --sort=-pcpu | grep -E 'chrome|chromium' | grep -v grep | head -8 | cut -c1-150", { encoding: 'utf8' });
    for (const l of ps.trim().split('\n')) out.push(`ps: ${l}`);
  } catch {
    /* no ps */
  }
  return out;
}

/** One line per open page: what it shows and which Web Locks are held or waited for. Used when a test times out. */
async function diagnose(contexts) {
  const lines = [];
  for (const [ci, ctx] of contexts.entries()) {
    for (const [pi, p] of ctx.pages().entries()) {
      const look = p
        .evaluate(async () => {
          let locks = null;
          try {
            const q = await navigator.locks.query();
            locks = { held: q.held.map((l) => `${l.name}:${l.mode}`), pending: q.pending.map((l) => `${l.name}:${l.mode}`) };
          } catch {
            /* no Web Locks here */
          }
          return {
            url: location.href.slice(-50),
            visible: document.visibilityState,
            guard: document.getElementById('guard-title')?.textContent || null,
            crash: !!document.getElementById('crash-panel'),
            appChildren: document.getElementById('app')?.children.length ?? null,
            pitch: !!document.getElementById('pitch'),
            note: document.getElementById('guard-note')?.textContent || null,
            locks,
          };
        })
        .catch((e) => `evaluate failed: ${e.message.split('\n')[0]}`);
      const info = await Promise.race([look, new Promise((r) => setTimeout(() => r('the page did not answer within 3 s'), 3000))]);
      lines.push(`context ${ci} page ${pi}: ${typeof info === 'string' ? info : JSON.stringify(info)}`);
    }
  }
  return lines;
}

function executablePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  return fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
}

// Network noise we never want to fail on: web fonts are not reachable (or wanted) in CI sandboxes.
const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/;
// The page links /manifest.webmanifest and /icons/* by root-relative URL, which cannot resolve on file://.
const ROOT_ASSET = /^file:\/\/\/(manifest\.webmanifest|icons\/|sw\.js)/;

async function main() {
  if (!fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'index.html'))) {
    console.error('dist/index.html is missing. Run `bun run build` first (or use `bun run e2e`).');
    process.exit(2);
  }
  const tests = registry.filter((t) => t.name.toLowerCase().includes(filter));
  if (!tests.length) {
    console.error(`No tests match "${filter}".`);
    process.exit(2);
  }

  // WebGL for the 3D match view: headless Chromium falls back to SwiftShader (software), which the
  // game detects and renders at low quality. E2E_RENDERER=2d forces the 2D canvas fallback instead.
  const browser = await chromium.launch({
    executablePath: executablePath(),
    headless: !process.env.E2E_HEADED,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  console.log(`Derby Day e2e: ${tests.length} tests against ${APP_URL}\n`);

  const results = [];
  let wedged = false;
  for (const t of tests) {
    const started = Date.now();
    const contexts = [];
    const problems = [];
    const sessions = []; // CDP sessions the runner attached (CPU throttle): released before the contexts are closed
    let onCrash;
    const crashed = new Promise((_, rej) => (onCrash = rej));
    crashed.catch(() => {}); // only the race below reads it
    const harness = {
      browser,
      /** Open a page in a fresh, isolated context that is collected for page-error checks. */
      async newPage(contextOptions = {}) {
        const ctx = await browser.newContext(contextOptions);
        contexts.push(ctx);
        // Fonts are blocked for every page of the context, including pages opened later in it (nextVisit, openApp's second page).
        await ctx.route(FONT_HOST, (route) => route.abort());
        const attach = async (p) => {
          p.setDefaultTimeout(20_000);
          // E2E_CPU_THROTTLE=6 slows the page's CPU like a busy CI runner, to shake out timing races.
          const throttle = Number(process.env.E2E_CPU_THROTTLE || 0);
          if (throttle > 1) {
            const cdp = await ctx.newCDPSession(p);
            sessions.push(cdp);
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
          }
          // A tab whose renderer dies would leave the test waiting for it for ever: fail the test now, saying which page.
          p.on('crash', () => onCrash(new Error(`a page crashed (its renderer process died): ${String(p.url()).slice(-60)}`)));
          p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
          p.on('console', (m) => {
            if (m.type() !== 'error') return;
            const url = m.location().url || '';
            if (FONT_HOST.test(url) || FONT_HOST.test(m.text()) || ROOT_ASSET.test(url)) return;
            problems.push(`console.error: ${m.text()}`);
          });
        };
        const page = await ctx.newPage();
        await attach(page);
        // A page opened later in the same context gets the same watch, so an error there still fails the test.
        ctx.on('page', (p) => void attach(p));
        return page;
      },
    };
    let error = null;
    let timer;
    let diag = [];
    try {
      await Promise.race([
        crashed,
        t.fn(harness),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`timed out after ${TIMEOUT} ms`)), TIMEOUT);
        }),
      ]);
      // Every test implicitly asserts the page stayed error-free.
      if (problems.length) throw new Error(`page reported errors:\n      ${problems.join('\n      ')}`);
    } catch (e) {
      error = e;
      // A timeout says nothing about *where*: look at every page now, before the contexts are closed.
      if (/timed out/.test(String(e && e.message))) diag = await diagnose(contexts);
    } finally {
      clearTimeout(timer);
      // Closing can itself stall (a wedged page, the GPU process): bound it, say so, and carry on with the next test.
      // Orderly: put the CPU rate back and detach our CDP sessions, close the pages one at a time, then the contexts.
      // (With the sessions left attached, context.close() was seen to stall about one run in five under throttle while
      // page.close() on the same pages worked at once, with the browser otherwise healthy.)
      const bounded = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
      await Promise.all(sessions.map((c) => bounded(c.send('Emulation.setCPUThrottlingRate', { rate: 1 }).then(() => c.detach()), 3000)));
      await Promise.all(contexts.flatMap((c) => c.pages().map((pg) => bounded(pg.close(), 5000))));
      const stalledAt = [];
      const closed = await Promise.race([
        Promise.all(
          contexts.map(async (c, ci) => {
            const t0 = Date.now();
            const tick = setTimeout(() => stalledAt.push(`context ${ci} still closing after ${(CLOSE_TIMEOUT / 2000).toFixed(0)} s; pages: ${c.pages().map((pg) => (pg.isClosed() ? 'closed' : 'open')).join(',')}`), CLOSE_TIMEOUT / 2);
            await c.close().catch(() => {});
            clearTimeout(tick);
            if (Date.now() - t0 > 2000) stalledAt.push(`context ${ci} took ${Date.now() - t0} ms to close`);
          }),
        ).then(() => true),
        new Promise((r) => setTimeout(() => r(false), CLOSE_TIMEOUT)),
      ]);
      for (const line of stalledAt) diag.push(line);
      if (!closed) diag = diag.concat(await probeStall(browser, contexts));
      if (!closed) {
        diag = diag.concat(await diagnose(contexts));
        error = new Error(`${error ? error.message + '\n      ' : ''}closing the test's browser contexts did not finish within ${CLOSE_TIMEOUT / 1000} s`);
        wedged = true;
      }
    }
    const ms = Date.now() - started;
    results.push({ name: t.name, ok: !error, ms, error });
    console.log(`${error ? 'FAIL' : 'PASS'}  ${t.name}  (${(ms / 1000).toFixed(1)}s)`);
    if (error) console.log(`      ${String(error && error.message ? error.message : error).split('\n').join('\n      ')}`);
    for (const line of diag) console.log(`      [page state] ${line}`);
    // A browser that would not close a context is not going to run the next test sensibly: stop with a clear message.
    if (wedged) {
      console.log('\nThe browser is wedged (a context would not close); stopping here instead of hanging.');
      results.push({ name: '(runner) browser wedged after the test above', ok: false, ms: 0, error: new Error('wedged') });
      break;
    }
  }
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, CLOSE_TIMEOUT))]);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(` - ${f.name}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
