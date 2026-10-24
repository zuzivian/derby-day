#!/usr/bin/env node
// Tiny e2e runner for Through Ball. No test framework: see lib/harness.cjs.
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

function executablePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  return fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
}

// Network noise we never want to fail on: web fonts are not reachable (or wanted) in CI sandboxes.
const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/;

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

  const browser = await chromium.launch({ executablePath: executablePath(), headless: !process.env.E2E_HEADED });
  console.log(`Through Ball e2e: ${tests.length} tests against ${APP_URL}\n`);

  const results = [];
  for (const t of tests) {
    const started = Date.now();
    const contexts = [];
    const problems = [];
    const harness = {
      browser,
      /** Open a page in a fresh, isolated context that is collected for page-error checks. */
      async newPage(contextOptions = {}) {
        const ctx = await browser.newContext(contextOptions);
        contexts.push(ctx);
        const page = await ctx.newPage();
        page.setDefaultTimeout(20_000);
        // E2E_CPU_THROTTLE=6 slows the page's CPU like a busy CI runner, to shake out timing races.
        const throttle = Number(process.env.E2E_CPU_THROTTLE || 0);
        if (throttle > 1) {
          const cdp = await ctx.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
        }
        await page.route(FONT_HOST, (route) => route.abort());
        page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          const url = m.location().url || '';
          if (FONT_HOST.test(url) || FONT_HOST.test(m.text())) return;
          problems.push(`console.error: ${m.text()}`);
        });
        return page;
      },
    };
    let error = null;
    let timer;
    try {
      await Promise.race([
        t.fn(harness),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`timed out after ${TIMEOUT} ms`)), TIMEOUT);
        }),
      ]);
      // Every test implicitly asserts the page stayed error-free.
      if (problems.length) throw new Error(`page reported errors:\n      ${problems.join('\n      ')}`);
    } catch (e) {
      error = e;
    } finally {
      clearTimeout(timer);
      await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    }
    const ms = Date.now() - started;
    results.push({ name: t.name, ok: !error, ms, error });
    console.log(`${error ? 'FAIL' : 'PASS'}  ${t.name}  (${(ms / 1000).toFixed(1)}s)`);
    if (error) console.log(`      ${String(error && error.message ? error.message : error).split('\n').join('\n      ')}`);
  }
  await browser.close();

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
