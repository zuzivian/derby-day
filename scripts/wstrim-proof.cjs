#!/usr/bin/env node
// Proof that the template-whitespace trim (scripts/html-trim.ts) changes nothing a player can see.
//
//   node scripts/wstrim-proof.cjs [outDir]
//
// Builds the app twice from the same sources (DERBY_NO_WSTRIM=1 and the default), renders every screen of each build with seeded
// randomness and a paused fake clock, and compares per screen and per viewport (1280x800, 390x844):
//   (a) screenshots, pixel for pixel;
//   (b) a DOM dump: strict (element structure, attributes, every text node with whitespace collapsed, whitespace-only nodes kept as a
//       marker) and loose (whitespace-only nodes dropped, text trimmed and collapsed).
// A control build (the untrimmed one, rendered a second time) is compared the same way, so a screen that is not deterministic is
// reported as such instead of being blamed on the trim. Exit code 1 when any screen of the trimmed build differs from the original.

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(require('node:os').tmpdir(), 'wstrim-proof'));
fs.mkdirSync(out, { recursive: true });

function loadPlaywright() {
  for (const f of [() => require('playwright'), () => require('/opt/node22/lib/node_modules/playwright'), () => require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'))]) {
    try {
      return f();
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found');
}
const { chromium } = loadPlaywright();

const SAVE_KEY = 'derbyday.save.v1';
const PREFS_KEY = 'derbyday.prefs.v1';
const xpFor = (level) => 50 * level * (level - 1);
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
].filter((v) => !process.env.WSTRIM_VIEWPORT || v.name === process.env.WSTRIM_VIEWPORT);

function build(tag, env) {
  execSync('bun run scripts/build.ts', { cwd: root, env: { ...process.env, DERBY_BUILD_ID: 'proof', ...env }, stdio: 'ignore' });
  const dst = path.join(out, `${tag}.html`);
  fs.copyFileSync(path.join(root, 'dist', 'index.html'), dst);
  return dst;
}

/** The DOM as text (ids made from the clock, such as a replay's, are masked: how many fake seconds a wait loop advanced is not part of the markup). strict keeps whitespace-only text nodes as a marker; loose drops them. */
function domDump(strict) {
  const walk = (n, depth) => {
    if (n.nodeType === 3) {
      const raw = n.nodeValue;
      const t = raw.replace(/\s+/g, ' ');
      if (t.trim() === '') return strict ? ['  '.repeat(depth) + '␣'] : [];
      return ['  '.repeat(depth) + JSON.stringify(strict ? t : t.trim())];
    }
    if (n.nodeType !== 1) return [];
    if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return [];
    const attrs = [...n.attributes].map((a) => `${a.name}=${JSON.stringify(/^t[0-9a-z]{9,}$/.test(a.value) ? 't#' : a.value)}`).sort().join(' ');
    const lines = ['  '.repeat(depth) + `<${n.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}>`];
    for (const c of n.childNodes) lines.push(...walk(c, depth + 1));
    return lines;
  };
  return walk(document.body, 0).join('\n');
}

async function newSession(browser, file, vp, { prefs, level = 99, xp, fresh = false, query = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: 'light', reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort().catch(() => {}));
  await ctx.addInitScript(() => {
    let a = 0x9e3779b9; // mulberry32: every page of the run sees the same random numbers
    Math.random = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    window.__e2e = true;
    window.__e2eSkipTabGuard = true;
    window.__e2eSpeed = 8;
  });
  // Paused before any page exists, so Date.now() at boot (it seeds the new club) is the same every run.
  await ctx.clock.install({ time: new Date('2026-06-01T12:00:00Z') });
  await ctx.clock.pauseAt(new Date('2026-06-01T12:00:01Z'));
  const url = pathToFileURL(file).href + `?renderer=2d${query}`;
  const settle = async (page, ms = 1500) => {
    await page.clock.runFor(ms);
  };
  let page = await ctx.newPage();
  if (fresh) {
    if (prefs) await page.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify(v)); }, [PREFS_KEY, prefs]);
    await page.goto(url);
    await settle(page);
    return { ctx, page, settle };
  }
  await page.goto(url);
  await page.waitForSelector('#app *');
  await settle(page);
  // Seed the save and prefs like tests/e2e/lib/helpers.cjs openApp, then boot a second page on them.
  const setXp = xp !== undefined ? xp : xpFor(level);
  await page.evaluate(
    ([sk, pk, p, x]) => {
      const save = JSON.parse(localStorage.getItem(sk));
      save.xp = x;
      delete save.unlocksSeen;
      localStorage.setItem(sk, JSON.stringify(save));
      localStorage.setItem(pk, JSON.stringify(p));
    },
    [SAVE_KEY, PREFS_KEY, { onboarded: true, controls: 'mouse', ...(prefs || {}) }, setXp],
  );
  const held = await page.evaluate(() => Object.entries(localStorage));
  page = await ctx.newPage();
  await page.addInitScript((entries) => { for (const [k, v] of entries) if (localStorage.getItem(k) !== v) localStorage.setItem(k, v); }, held);
  await page.goto(url);
  await page.waitForSelector('#app *');
  await settle(page);
  return { ctx, page, settle };
}

/** Every screen of one build at one viewport: name -> { png, dom, domLoose }. */
async function renderAll(browser, file, vp, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const res = {};
  const snap = async (name, page) => {
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    fs.writeFileSync(path.join(dir, `${name}.png`), png);
    res[name] = { png, dom: await page.evaluate(`(${domDump.toString()})(true)`), domLoose: await page.evaluate(`(${domDump.toString()})(false)`) };
    fs.writeFileSync(path.join(dir, `${name}.dom.txt`), res[name].dom);
  };
  const click = async (page, sel, settle) => {
    await page.locator(sel).first().click();
    await settle(page, 600);
  };

  // Tabs at club level 99 (every screen unlocked).
  {
    const s = await newSession(browser, file, vp, { prefs: { halfSeconds: 3 } });
    for (const tab of ['home', 'squad', 'transfers', 'training', 'ladder', 'competitions', 'club']) {
      await click(s.page, `[data-action="nav"][data-screen="${tab}"]`, s.settle);
      await snap(`tab-${tab}`, s.page);
    }
    // The club level panel (Club tab) and the settings/backup dialog, if reachable.
    for (const [name, sel] of [['level-panel', '[data-action="level-open"]'], ['settings', '[data-action="settings"], [data-action="open-settings"]']]) {
      if (await s.page.locator(sel).count()) {
        await click(s.page, sel, s.settle);
        await snap(name, s.page);
        await s.page.keyboard.press('Escape');
        await s.settle(s.page, 400);
      }
    }
    await s.ctx.close();
  }

  // Match HUD, pause, result dialog.
  {
    const s = await newSession(browser, file, vp, { prefs: { halfSeconds: 3 } });
    await click(s.page, '[data-action="nav"][data-screen="home"]', s.settle);
    await click(s.page, '[data-action="play-ranked"]', s.settle);
    await s.page.waitForSelector('#pitch');
    await s.settle(s.page, 1200);
    await snap('match-hud', s.page);
    await s.page.locator('#pause-btn').click();
    await s.settle(s.page, 400);
    await snap('match-pause', s.page);
    await s.page.locator('#resume').click();
    for (let i = 0; i < 60 && !(await s.page.locator('.modal [data-action="close-result"]').count()); i++) await s.settle(s.page, 1000);
    await s.page.waitForSelector('.modal [data-action="close-result"]', { timeout: 5000 });
    await s.settle(s.page, 600);
    await snap('result-dialog', s.page);
    await s.ctx.close();
  }

  // Level-up dialog: cross level 7 on a short match.
  {
    const s = await newSession(browser, file, vp, { prefs: { halfSeconds: 3 }, xp: xpFor(7) - 10 });
    await click(s.page, '[data-action="play-ranked"]', s.settle);
    for (let i = 0; i < 60 && !(await s.page.locator('.modal [data-action="close-result"]').count()); i++) await s.settle(s.page, 1000);
    await s.page.locator('.modal [data-action="close-result"]').click();
    await s.settle(s.page, 800);
    await s.page.waitForSelector('[aria-labelledby="levelup-title"]', { timeout: 5000 });
    await snap('level-up', s.page);
    await s.ctx.close();
  }

  // Penalty shootout: a 1 s match with no input ends level in a cup tie often; the seeded random makes it the same draw each time.
  {
    let shot = false;
    for (let attempt = 0; attempt < 6 && !shot; attempt++) {
      const s = await newSession(browser, file, vp, { prefs: { halfSeconds: 1 }, query: '' });
      await click(s.page, '[data-action="nav"][data-screen="competitions"]', s.settle);
      await click(s.page, '[data-action="comp-start-cup"]', s.settle);
      await snap('cup-bracket', s.page);
      await click(s.page, '[data-action="comp-play"][data-kind="cup"]', s.settle);
      for (let i = 0; i < 40; i++) {
        if ((await s.page.locator('.shootout').count()) || (await s.page.locator('.modal').count())) break;
        await s.settle(s.page, 1000);
      }
      if (await s.page.locator('.shootout').count()) {
        await s.settle(s.page, 800);
        await snap('shootout-start', s.page);
        await s.page.locator('#so-quick').click().catch(() => {});
        await s.settle(s.page, 2500);
        await snap('shootout-kick', s.page);
        shot = true;
      }
      await s.ctx.close();
      if (!shot) delete res['cup-bracket'];
    }
    if (!shot) res['shootout-start'] = res['shootout-start'] || { png: Buffer.from('no-shootout'), dom: 'no shootout reached', domLoose: 'no shootout reached' };
  }

  // Onboarding: the welcome, then the first match with a coach tip and the celebration.
  {
    const s = await newSession(browser, file, vp, { fresh: true, prefs: { halfSeconds: 3 } });
    await s.page.waitForSelector('#ob-kickoff');
    await snap('onboarding-welcome', s.page);
    await s.page.locator('#ob-kickoff').click();
    await s.page.waitForSelector('#pitch');
    await s.settle(s.page, 4000);
    await snap('onboarding-match-tip', s.page);
    for (let i = 0; i < 60 && !(await s.page.locator('.ob-celebrate').count()); i++) await s.settle(s.page, 1000);
    if (await s.page.locator('.ob-celebrate').count()) {
      await s.settle(s.page, 800);
      await snap('onboarding-celebrate', s.page);
      await s.page.locator('[data-ob="next"]').click();
      await s.settle(s.page, 600);
      await snap('onboarding-name', s.page);
    }
    await s.ctx.close();
  }
  return res;
}

const diffPng = (a, b) => a.equals(b);

(async () => {
  const files = { old: build('old', { DERBY_NO_WSTRIM: '1' }), new: build('new', {}) };
  const oldBytes = fs.statSync(files.old).size;
  const newBytes = fs.statSync(files.new).size;
  const gz = (f) => zlib.gzipSync(fs.readFileSync(f)).length;
  console.log(`bytes: old ${oldBytes}, new ${newBytes}, saved ${oldBytes - newBytes}; gzip old ${gz(files.old)}, new ${gz(files.new)}, saved ${gz(files.old) - gz(files.new)}`);

  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  let bad = 0;
  let compared = 0;
  let nondeterministic = 0;
  for (const vp of VIEWPORTS) {
    const a = await renderAll(browser, files.old, vp, path.join(out, 'shots', vp.name, 'old'));
    const b = await renderAll(browser, files.new, vp, path.join(out, 'shots', vp.name, 'new'));
    const c = await renderAll(browser, files.old, vp, path.join(out, 'shots', vp.name, 'control'));
    for (const name of Object.keys(a)) {
      const x = a[name];
      const y = b[name];
      const z = c[name];
      if (!y) {
        console.log(`MISSING ${vp.name}/${name} in the trimmed build`);
        bad++;
        continue;
      }
      const pixel = diffPng(x.png, y.png);
      const dom = x.dom === y.dom;
      const loose = x.domLoose === y.domLoose;
      const ctlPixel = z ? diffPng(x.png, z.png) : false;
      const ctlDom = z ? x.dom === z.dom : false;
      compared++;
      const ok = pixel && dom && loose;
      if (!ctlPixel || !ctlDom) nondeterministic++;
      if (!ok) bad++;
      console.log(`${ok ? 'same' : 'DIFF'}  ${vp.name.padEnd(7)} ${name.padEnd(20)} pixels:${pixel ? 'equal' : 'DIFFER'} dom-strict:${dom ? 'equal' : 'DIFFER'} dom-loose:${loose ? 'equal' : 'DIFFER'}   control(old vs old) pixels:${ctlPixel ? 'equal' : 'differ'} dom:${ctlDom ? 'equal' : 'differ'}`);
    }
  }
  await browser.close();
  console.log(`\n${compared} screens compared, ${bad} differ, ${nondeterministic} not reproducible between two renders of the same build`);
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
