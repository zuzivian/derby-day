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
//   E2E_SHARD=k/n        run the k-th of n groups of tests, as CI's parallel jobs do (lib/shard.cjs)
//   E2E_TIMINGS_FILE     write each test's seconds there as JSON (tests/e2e/weights.cjs turns them into shard-weights.json)
//   E2E_JOBS=n           run the suite as n shards side by side, each its own runner and browser (default 1)
//   E2E_PAGE_CLOSE_MS    how long a test's pages may take to close before the browser is killed and relaunched (default 1500)
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

const { chromium } = process.argv[2] === '--list' ? {} : loadPlaywright(); // listing needs no browser
const { registry } = require('./lib/harness.cjs');
const { shardItems } = require('./lib/shard.cjs');
const { APP_URL } = require('./lib/helpers.cjs');

// Test files: every *.e2e.cjs next to this runner, in name order. All of them are loaded (that only registers their tests),
// so every shard sees the same list of tests to split.
const ALL_FILES = fs.readdirSync(__dirname).filter((n) => n.endsWith('.e2e.cjs')).sort();
const fileOf = new Map(); // test -> file, for E2E_FILES and the per-file timings
for (const f of ALL_FILES) {
  const before = registry.length;
  require(path.join(__dirname, f));
  for (const t of registry.slice(before)) fileOf.set(t, f);
}

/**
 * Sharding for CI: E2E_SHARD=k/n runs the k-th of n groups of tests (1-based), balanced by the seconds per test in
 * tests/e2e/shard-weights.json (refreshed from CI's timings with tests/e2e/weights.cjs). See lib/shard.cjs.
 */
let WEIGHTS = {};
try {
  WEIGHTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'shard-weights.json'), 'utf8'));
} catch {
  /* no weights yet: equal */
}
const SHARD = process.env.E2E_SHARD || '';
let picked;
try {
  picked = new Set(shardItems(registry.map((t) => t.name), SHARD, WEIGHTS));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
// E2E_FILES=replay,club runs only the tests in files whose name contains one of these (for soaking one file under load).
const ONLY = String(process.env.E2E_FILES || '').split(',').map((x) => x.trim()).filter(Boolean);
const inShard = registry.filter((t) => picked.has(t.name) && (!ONLY.length || ONLY.some((o) => fileOf.get(t).includes(o))));

const filter = String((process.argv[2] === '--list' ? process.argv[3] : process.argv[2]) || '').toLowerCase();
const LIST_ONLY = process.argv[2] === '--list';
const TIMEOUT = Number(process.env.E2E_TIMEOUT_MS || 90_000);
/** How long closing a test's contexts (and the browser) may take before the runner gives up on it. */
const CLOSE_TIMEOUT = Number(process.env.E2E_CLOSE_TIMEOUT_MS || 20_000);
/** How long a test's pages may take to close before the runner kills the browser and relaunches it instead of waiting. */
const PAGE_CLOSE_MS = Number(process.env.E2E_PAGE_CLOSE_MS || 1500);
/** A context that took longer than this to close leaves the browser suspect: the next test gets a fresh one. */
const RELAUNCH_AFTER_MS = 8000;
/** Wedges (a context that would not close within CLOSE_TIMEOUT) recovered by killing and relaunching the browser; one more fails the run. */
const MAX_WEDGES = 3;

/**
 * The process group of the browser this runner launched: Playwright starts it as our own child, detached, so it
 * leads its own group. `seen` are groups already used (an old browser can linger as a zombie). 0 when not found.
 */
function browserGroup(seen) {
  try {
    const rows = require('node:child_process')
      .execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,args='], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], args: m[4] }));
    const mine = rows.filter((x) => x.ppid === process.pid && x.pid === x.pgid && /chrom/i.test(x.args) && !seen.has(x.pgid));
    return mine.length ? mine[mine.length - 1].pgid : 0;
  } catch {
    return 0; // no ps
  }
}

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
            text: (document.getElementById('app')?.innerText || '').replace(/\s+/g, ' ').slice(0, 140),
            storage: (() => {
              try {
                return Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('derbyday')).map((k) => [k.replace('derbyday.', ''), localStorage.getItem(k).length]));
              } catch (e) {
                return `unreadable: ${e.message}`;
              }
            })(),
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
const BROWSER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/;
// The page links /manifest.webmanifest and /icons/* by root-relative URL, which cannot resolve on file://.
// The same links as they are named inside a message (a profile on disk reports the manifest as a CORS error, not a 404).
const ROOT_ASSET_TEXT = /file:\/\/\/(manifest\.webmanifest|icons\/|sw\.js)/;
const ROOT_ASSET = /^file:\/\/\/(manifest\.webmanifest|icons\/|sw\.js)/;

async function main() {
  const tests = inShard.filter((t) => t.name.toLowerCase().includes(filter));
  if (!tests.length && SHARD && registry.some((t) => t.name.toLowerCase().includes(filter))) {
    console.log(`Shard ${SHARD}: none of the tests asked for are in this shard.`);
    return;
  }
  if (!tests.length) {
    console.error(`No tests match "${filter}".`);
    process.exit(2);
  }

  if (LIST_ONLY) {
    for (const t of tests) console.log(`${fileOf.get(t)}\t${t.name}`);
    return;
  }
  if (!fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'index.html'))) {
    console.error('dist/index.html is missing. Run `bun run build` first (or use `bun run e2e`).');
    process.exit(2);
  }

  // WebGL for the 3D match view: headless Chromium falls back to SwiftShader (software), which the
  // game detects and renders at low quality. E2E_RENDERER=2d forces the 2D canvas fallback instead.
  const launch = () => chromium.launch({ executablePath: executablePath(), headless: !process.env.E2E_HEADED, args: BROWSER_ARGS });
  let browser = await launch();
  const groups = new Set();
  let group = browserGroup(groups);
  groups.add(group);
  /** Kill this runner's browser (its process group, by the pid we launched, nothing else on the machine) and start a fresh one. */
  async function relaunchHard() {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      /* already gone */
    }
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    browser = await launch();
    group = browserGroup(groups);
    groups.add(group);
  }
  const expected = tests.reduce((sum, t) => sum + (typeof WEIGHTS[t.name] === 'number' ? WEIGHTS[t.name] : 0), 0);
  const files = [...new Set(tests.map((t) => fileOf.get(t)))];
  console.log(`Derby Day e2e: ${tests.length} tests against ${APP_URL}${SHARD ? ` (shard ${SHARD}, about ${Math.round(expected)} s by shard-weights.json, from ${files.join(', ')})` : ''}\n`);

  const results = [];
  let wedged = false;
  let wedges = 0;
  for (const t of tests) {
    const started = Date.now();
    const contexts = [];
    const problems = [];
    const sessions = []; // CDP sessions the runner attached (CPU throttle): released before the contexts are closed
    const expectedCrash = new WeakSet(); // pages the test is about to crash on purpose (t.expectCrash)
    let onCrash;
    const crashed = new Promise((_, rej) => (onCrash = rej));
    crashed.catch(() => {}); // only the race below reads it
    const harness = {
      browser,
      /** Say that this page is about to be crashed on purpose, so its renderer dying does not fail the test. */
      expectCrash(page) {
        expectedCrash.add(page);
      },
      /** Open a page in a fresh, isolated context that is collected for page-error checks. */
      async newPage(contextOptions = {}) {
        const ctx = await browser.newContext(contextOptions);
        contexts.push(ctx);
        // A test's own CDP sessions (metrics, DPR, GC) are released before the close too, like the runner's.
        const newCDPSession = ctx.newCDPSession.bind(ctx);
        ctx.newCDPSession = async (p) => {
          const cdp = await newCDPSession(p);
          sessions.push(cdp);
          return cdp;
        };
        // Fonts are blocked for every page of the context, including pages opened later in it (nextVisit, openApp's second page).
        await ctx.route(FONT_HOST, (route) => route.abort().catch(() => {})); // the browser may be killed mid-request (teardown)
        const attach = async (p) => {
          p.setDefaultTimeout(20_000);
          // E2E_CPU_THROTTLE=6 slows the page's CPU like a busy CI runner, to shake out timing races.
          const throttle = Number(process.env.E2E_CPU_THROTTLE || 0);
          if (throttle > 1) {
            const cdp = await ctx.newCDPSession(p);
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
          }
          // A tab whose renderer dies would leave the test waiting for it for ever: fail the test now, saying which page.
          p.on('crash', () => expectedCrash.has(p) || onCrash(new Error(`a page crashed (its renderer process died): ${String(p.url()).slice(-60)}`)));
          p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
          p.on('console', (m) => {
            if (m.type() !== 'error') return;
            const url = m.location().url || '';
            if (FONT_HOST.test(url) || FONT_HOST.test(m.text()) || ROOT_ASSET.test(url) || ROOT_ASSET_TEXT.test(m.text())) return;
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
    // A test can ask for more time (harness.cjs test opts); a CPU-throttled run scales it.
    const limit = Math.max(TIMEOUT, (t.timeoutMs || 0) * Math.max(1, Number(process.env.E2E_CPU_THROTTLE || 1) / 2));
    try {
      await Promise.race([
        crashed,
        t.fn(harness),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`timed out after ${limit} ms`)), limit);
        }),
      ]);
      // Every test implicitly asserts the page stayed error-free.
      if (problems.length) throw new Error(`page reported errors:\n      ${problems.join('\n      ')}`);
    } catch (e) {
      error = e;
      // A failure (a timeout above all) says nothing about *where*: look at every page now, before the contexts are closed.
      diag = await diagnose(contexts);
    } finally {
      clearTimeout(timer);
      // Closing can itself stall (a wedged page, the GPU process): bound it, say so, and carry on with the next test.
      // Orderly: put the CPU rate back and detach our CDP sessions, close the pages one at a time, then the contexts.
      // (With the sessions left attached, context.close() was seen to stall about one run in five under throttle while
      // page.close() on the same pages worked at once, with the browser otherwise healthy.)
      const bounded = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
      await Promise.all(sessions.map((c) => bounded(c.send('Emulation.setCPUThrottlingRate', { rate: 1 }).then(() => c.detach()), 3000)));
      // Not goto('about:blank') first: on a busy 3D page (SwiftShader at DPR 2) the navigation did not even commit within
      // 3 s, and blank-then-close took 3.5-5 s where a plain close took 1.4 s.
      const p0 = Date.now();
      const pagesClosed = await Promise.race([
        Promise.all(contexts.flatMap((c) => c.pages().map((pg) => pg.close().catch(() => {})))).then(() => true),
        new Promise((r) => setTimeout(() => r(false), group > 0 ? PAGE_CLOSE_MS : 5000)),
      ]);
      const stalledAt = [];
      let closed = true;
      let slowest = 0;
      if (!pagesClosed && group > 0) {
        // The test is judged on its own steps alone, so a page slow to close is not waited for: on CI a busy 3D page under
        // SwiftShader took 5 s and more to close, then its context 3-20 s, test after test. Kill the browser and start a
        // fresh one instead (about 0.3 s); the next test gets a clean browser either way.
        await relaunchHard();
        stalledAt.push(`pages still closing after ${PAGE_CLOSE_MS} ms: killed the browser and relaunched it`);
      } else {
        if (Date.now() - p0 > 2000) stalledAt.push(`pages took ${Date.now() - p0} ms to close`);
        closed = await Promise.race([
          Promise.all(
            contexts.map(async (c, ci) => {
              const t0 = Date.now();
              const tick = setTimeout(() => stalledAt.push(`context ${ci} still closing after ${(CLOSE_TIMEOUT / 2000).toFixed(0)} s; pages: ${c.pages().map((pg) => (pg.isClosed() ? 'closed' : 'open')).join(',')}`), CLOSE_TIMEOUT / 2);
              await c.close().catch(() => {});
              clearTimeout(tick);
              slowest = Math.max(slowest, Date.now() - t0);
              if (Date.now() - t0 > 2000) stalledAt.push(`context ${ci} took ${Date.now() - t0} ms to close`);
            }),
          ).then(() => true),
          new Promise((r) => setTimeout(() => r(false), CLOSE_TIMEOUT)),
        ]);
      }
      for (const line of stalledAt) diag.push(line);
      if (!closed) diag = diag.concat(await probeStall(browser, contexts));
      if (!closed && group > 0) {
        // Wedged: the pages closed but a context would not. Kill the browser, start a fresh one and carry on with the next test.
        diag = diag.concat(await diagnose(contexts));
        wedges++;
        await relaunchHard();
        diag.push(`WEDGE ${wedges}: a context would not close within ${CLOSE_TIMEOUT / 1000} s; killed the browser and relaunched it (more than ${MAX_WEDGES} fails the run)`);
        if (wedges > MAX_WEDGES) wedged = true;
      } else if (!closed) {
        // Without the browser's process group (no ps) it can't be killed safely: stop, as before.
        diag = diag.concat(await diagnose(contexts));
        error = new Error(`${error ? error.message + '\n      ' : ''}closing the test's browser contexts did not finish within ${CLOSE_TIMEOUT / 1000} s`);
        wedged = true;
      } else if (slowest > RELAUNCH_AFTER_MS) {
        // It closed, but slowly enough that the browser (its GPU process above all) is not to be trusted with the next test.
        if (group > 0) await relaunchHard();
        else {
          await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, CLOSE_TIMEOUT))]);
          browser = await launch();
        }
        diag.push(`relaunched the browser after a ${slowest} ms close`);
      }
    }
    const ms = Date.now() - started;
    results.push({ name: t.name, ok: !error, ms, error });
    console.log(`${error ? 'FAIL' : 'PASS'}  ${t.name}  (${(ms / 1000).toFixed(1)}s)`);
    if (error) console.log(`      ${String(error && error.message ? error.message : error).split('\n').join('\n      ')}`);
    for (const line of diag) console.log(`      [page state] ${line}`);
    // A browser that would not close a context is not going to run the next test sensibly: stop with a clear message.
    if (wedged) {
      const why = wedges > MAX_WEDGES ? `wedged ${wedges} times (more than ${MAX_WEDGES})` : 'wedged (a context would not close)';
      console.log(`\nThe browser ${why}; stopping here instead of hanging.`);
      results.push({ name: `(runner) browser ${why} by the test above`, ok: false, ms: 0, error: new Error('wedged') });
      break;
    }
  }
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, CLOSE_TIMEOUT))]);

  // Seconds per test, for tests/e2e/shard-weights.json: written to E2E_TIMINGS_FILE (CI keeps it as an artifact, and
  // tests/e2e/weights.cjs merges them), and with E2E_TIMINGS=1 also printed per file.
  const perTest = {};
  tests.forEach((t, i) => {
    if (results[i]) perTest[t.name] = Math.round(results[i].ms / 100) / 10;
  });
  if (process.env.E2E_TIMINGS_FILE) fs.writeFileSync(process.env.E2E_TIMINGS_FILE, `${JSON.stringify(perTest, null, 2)}\n`);
  if (process.env.E2E_TIMINGS) {
    const perFile = {};
    for (const t of tests) if (t.name in perTest) perFile[fileOf.get(t)] = Math.round((perFile[fileOf.get(t)] || 0) + perTest[t.name]);
    console.log(`\nPer-file seconds: ${JSON.stringify(perFile)}`);
  }
  const took = Object.values(perTest).reduce((a, b) => a + b, 0);
  if (SHARD && expected > 0) {
    console.log(`\nShard ${SHARD}: ${Math.round(took)} s of tests, ${Math.round(expected)} s expected by shard-weights.json`);
    // Weights gone stale leave one shard far longer than the rest: say so where CI shows it (refresh with tests/e2e/weights.cjs).
    if (process.env.GITHUB_ACTIONS && took > expected * 1.3 + 30) console.log(`::warning::e2e shard ${SHARD} took ${Math.round(took)} s, expected ${Math.round(expected)} s: tests/e2e/shard-weights.json is stale (refresh it with tests/e2e/weights.cjs)`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
  if (wedges) console.log(`Browser wedges: ${wedges} (each recovered by killing and relaunching the browser; more than ${MAX_WEDGES} fails the run)`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(` - ${f.name}`);
  }
  process.exit(failed.length ? 1 : 0);
}

// Teardown kills the browser under a finished test (relaunchHard): a promise of that test still waiting on the browser then
// rejects with nobody left to catch it. Only those are ignored; any other unhandled rejection still ends the run.
process.on('unhandledRejection', (e) => {
  if (/Target page, context or browser has been closed|Browser has been closed|Target closed|browser has disconnected/i.test(String(e && e.message))) return;
  console.error(e);
  process.exit(1);
});

/**
 * E2E_JOBS=n: the suite as n shards side by side on this machine, each a runner of its own with its own browser, as CI's
 * jobs are. Each line of a shard's output is printed as it comes, tagged [k/n]; then the failures of all of them.
 */
function runParallel(n) {
  const { spawn } = require('node:child_process');
  const timings = process.env.E2E_TIMINGS_FILE;
  const started = Date.now();
  const runs = Array.from({ length: n }, (_, i) => {
    const tag = `[${i + 1}/${n}]`;
    const env = { ...process.env, E2E_SHARD: `${i + 1}/${n}`, E2E_JOBS: '1', ...(timings ? { E2E_TIMINGS_FILE: `${timings}.${i + 1}` } : {}) };
    const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const failed = [];
    const counts = { passed: 0, failed: 0 };
    let rest = '';
    const onData = (buf) => {
      const lines = (rest + buf).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        console.log(`${tag} ${line}`);
        if (line.startsWith('FAIL  ')) failed.push(line.slice(6));
        const m = /^(\d+) passed, (\d+) failed, \d+ total$/.exec(line);
        if (m) Object.assign(counts, { passed: +m[1], failed: +m[2] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    return new Promise((resolve) => child.on('close', (code) => resolve({ tag, code, failed, counts })));
  });
  Promise.all(runs).then((done) => {
    if (timings) {
      const merged = {};
      for (let k = 1; k <= n; k++) {
        const f = `${timings}.${k}`;
        if (!fs.existsSync(f)) continue;
        Object.assign(merged, JSON.parse(fs.readFileSync(f, 'utf8')));
        fs.unlinkSync(f);
      }
      fs.writeFileSync(timings, `${JSON.stringify(merged, null, 2)}\n`);
    }
    const passed = done.reduce((a, r) => a + r.counts.passed, 0);
    const failed = done.flatMap((r) => r.failed.map((f) => `${r.tag} ${f}`));
    const crashed = done.filter((r) => r.code !== 0 && !r.failed.length);
    console.log(`\n${n} shards in ${Math.round((Date.now() - started) / 1000)} s: ${passed} passed, ${failed.length} failed`);
    for (const f of failed) console.log(` - ${f}`);
    for (const r of crashed) console.log(` - ${r.tag} exited with code ${r.code} (see its output above)`);
    process.exit(failed.length || crashed.length ? 1 : 0);
  });
}

const JOBS = Number(process.env.E2E_JOBS || 1);
if (JOBS > 1 && !SHARD && !LIST_ONLY) runParallel(JOBS);
else
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
